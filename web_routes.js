/**
 * KuGou Music Web Routes
 * 搜索、播放、下载、登录、VIP
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const axios = require('axios');
const { createRequest } = require('./util/request');
const { decryptQmcFile } = require('./util/qmc_decrypt');
const { calculateMid, randomString } = require('./util/util');

// 懒加载推荐引擎
let recommend = null;
function getRecommend() {
  if (!recommend) {
    try {
      recommend = require('./recommend_engine');
      console.log('[recommend] Engine loaded successfully');
    } catch (e) {
      console.warn('[recommend] Engine load failed:', e.message, e.stack?.slice(0, 200));
      recommend = {
        recordPlay: () => { console.log('[recommend-mock] recordPlay called'); },
        addFavorite: () => false, removeFavorite: () => false,
        getHistory: () => [], getFavorites: () => [],
        getProfile: async () => ({}),
        generateRecommendations: async () => ({ reason: '推荐引擎未就绪', profile: {}, total_plays: 0 }),
      };
    }
  }
  return recommend;
}

const router = express.Router();

// ===== Session =====
const sessionPath = path.join(__dirname, '.kugou', 'session.json');
const downloadDir = path.join(__dirname, '.kugou', 'downloads');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
ensureDir(path.dirname(sessionPath));
ensureDir(downloadDir);

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { ...fallback }; }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function getSession() {
  return readJson(sessionPath, {
    cookies: {}, token: '', userid: '', dfid: '', pendingWxUuid: '', pendingQrKey: '', lastLoginAt: '',
    device: {},
  });
}

function saveSession(s) { writeJson(sessionPath, s); }

// ===== 设备上下文（未登录也能播免费/试听的关键） =====
const DEV_GUID = '0f607264fc631a92b9e13c65db7cd3c'; // 固定设备标识，保证重启后一致
function getDeviceCookies(session) {
  const dev = session?.device || {};
  const guid = dev.guid || DEV_GUID;
  return {
    KUGOU_API_GUID: guid,
    KUGOU_API_MID: dev.mid || calculateMid(guid),
    KUGOU_API_DEV: (dev.dev || 'default').toUpperCase(),
    KUGOU_API_MAC: dev.mac || '02:00:00:00:00:00',
  };
}

function mergeDevice(session) {
  if (!session.cookies) session.cookies = {};
  const dev = getDeviceCookies(session);
  if (!session.cookies.KUGOU_API_GUID) session.cookies.KUGOU_API_GUID = dev.guid;
  if (!session.cookies.KUGOU_API_MID) session.cookies.KUGOU_API_MID = dev.mid;
  if (!session.cookies.KUGOU_API_DEV) session.cookies.KUGOU_API_DEV = dev.dev;
  if (!session.cookies.KUGOU_API_MAC) session.cookies.KUGOU_API_MAC = dev.mac;
  if (session.device?.dfid && !session.cookies.dfid) session.cookies.dfid = session.device.dfid;
  session.device = session.device || {};
  session.device.guid = dev.guid;
  session.device.mid = dev.mid;
  session.device.dev = dev.dev;
  session.device.mac = dev.mac;
  return session;
}

async function registerDeviceId(session, force = false) {
  mergeDevice(session);
  // 防抖：瞬时失败后至少等 60s 再重试，避免狂拉风控接口
  const lastReg = session.device.lastReg || 0;
  const now = Date.now();
  if (session.cookies.dfid) return session;
  if (!force && now - lastReg < 60000) return session;
  session.device.lastReg = now;
  try {
    const regMod = require('./module/register_dev');
    const regResult = await regMod({ cookie: session.cookies }, createRequest);
    const regData = regResult?.body?.data;
    if (regData?.dfid) {
      session.cookies.dfid = String(regData.dfid);
      session.dfid = session.cookies.dfid;
      session.device.dfid = session.cookies.dfid;
      session.device.noDfid = false;
      console.log('[device] registered dfid:', session.cookies.dfid);
    } else {
      console.warn('[device] register_dev no dfid in response');
    }
  } catch (e) {
    // 瞬时失败不立即重试，等待下次 backoff 窗口
    console.warn('[device] register dfid failed (will retry later):', e.message);
  }
  saveSession(session);
  return session;
}

async function ensureDevice() { return registerDeviceId(mergeDevice(getSession())); }

function extractCookies(resp, session) {
  const cookies = resp?.cookie || [];
  if (Array.isArray(cookies)) {
    for (const line of cookies) {
      const first = String(line).split(';')[0] || '';
      const idx = first.indexOf('=');
      if (idx > 0) session.cookies[first.slice(0, idx).trim()] = first.slice(idx + 1).trim();
    }
  }
  if (session.cookies.token) session.token = session.cookies.token;
  if (session.cookies.userid) session.userid = String(session.cookies.userid);
  if (session.cookies.dfid) session.dfid = session.cookies.dfid;
}

// 直接调用模块（避开 HTTP 签名问题，自动保证设备 dfid）
async function callModule(modulePath, params) {
  const session = await ensureDevice();
  const mod = require(modulePath);
  return mod({ ...params, cookie: session.cookies }, createRequest).then(async (r) => {
    extractCookies(r, session);
    saveSession(session);
    return r.body || {};
  });
}

// 把底层 reject/异常归一成可读文本
function callErrorText(err, fallback = '请求失败，请稍后重试') {
  if (err instanceof Error) return err.message || fallback;
  if (err && typeof err === 'object') {
    const m = err.body?.msg || err.body?.error_msg || err.body?.error || err.msg || err.error_msg || err.error;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

// 安全调用模块：异常时返回可读结果而不抛，避免页面显示 undefined
async function callModuleSafe(modulePath, params, fallback = '网络异常，请稍后重试') {
  try { return await callModule(modulePath, params); }
  catch (e) {
    const errText = callErrorText(e, fallback);
    const code = e?.status || e?.code || -1;
    console.warn('[module-safe]', modulePath, 'err:', errText);
    return { status: 0, error_code: code, error_msg: errText };
  }
}

// 获取已登录用户资料
async function getUserProfile() {
  const p = await callModule('./module/user_detail', {});
  if (p.status === 1 && p.data) {
    return { ok: true, nickname: p.data.nickname || '', avatar: p.data.avatar || '', userid: p.data.userid || '' };
  }
  return { ok: false, code: p.error_code, reason: p.error_code === 20018 ? '登录已过期，请重新登录' : (p.error_msg || '获取用户信息失败') };
}

// 登录后自动领取每日 VIP（尽力而为）
async function autoClaimVip() {
  try {
    const s = getSession();
    if (!s.token || !s.userid) return { ok: false, reason: '未登录' };
    const v = await callModuleSafe('./module/youth_vip', {}, '查询失败');
    const done = Number(v?.data?.done || 0);
    if (done > 0) return { ok: false, already: true };
    const today = new Date().toISOString().slice(0, 10);
    const r1 = await callModuleSafe('./module/youth_day_vip', { receive_day: today }, '领取失败');
    if (r1.status === 1) {
      try { await callModule('./module/youth_day_vip_upgrade', {}); } catch {}
      console.log('[vip] 登录后自动领取成功:', today);
      return { ok: true };
    }
    return { ok: false, error: r1.error_msg || r1.error_code || '领取失败' };
  } catch (e) {
    console.warn('[vip] 自动领取异常:', callErrorText(e));
    return { ok: false, error: callErrorText(e) };
  }
}

// ===== 错误码字典 =====
const ERROR_MSG = {
  131001: '参数错误，请重新登录',
  20002: '今天已经领取过 VIP 了，明天再来吧',
  20018: '登录已过期，请重新扫码登录',
  20010: '参数错误，请重试',
};

function errorMsg(errCode, fallback = '操作失败') {
  return ERROR_MSG[errCode] || (errCode ? `操作失败 (错误码: ${errCode})` : fallback);
}

// ===== 工具函数 =====
function getMimeType(ext) {
  return { mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/x-wav' }[ext] || 'audio/mpeg';
}

// ===== API 路由 =====

// 1. 搜索歌曲
router.get('/api/search', async (req, res) => {
  try {
    const { keyword, page = 1, pagesize = 20 } = req.query;
    if (!keyword) return res.status(400).json({ code: 400, error: '缺少关键词' });

    const resp = await axios.get('http://mobilecdn.kugou.com/api/v3/search/song', {
      params: { format: 'json', keyword, page: parseInt(page), pagesize: parseInt(pagesize), showtype: 1 },
      timeout: 15000, proxy: false, validateStatus: () => true,
    });
    const body = resp.data || {};
    if (body.status !== 1 || !body.data?.info) {
      return res.json({ code: body.status || 0, error_code: body.errcode, error: body.error || '搜索失败', data: [] });
    }

    const songs = body.data.info.map((item) => {
      const groups = Array.isArray(item.group) ? item.group : [];
      const hashes = [];
      const add = (h) => { if (h && !hashes.includes(String(h).toUpperCase())) hashes.push(String(h).toUpperCase()); };
      add(item.sqhash); add(item['320hash']); add(item.hash);
      for (const g of groups) { add(g.sqhash); add(g['320hash']); add(g.hash); }

      return {
        songname: item.songname || '', singername: item.singername || '',
        album_name: item.album_name || '', duration: item.duration || 0,
        hash: (item.hash || '').toUpperCase(),
        sqhash: (item.sqhash || '').toUpperCase(), hash_320: (item['320hash'] || '').toUpperCase(),
        hashes, album_id: item.album_id || 0,
        // 酷狗 /v5/url 需要的是 album_audio_id（主版本 mixsongid），audio_id 常常不一致
        album_audio_id: Number(item.album_audio_id || 0),
        audio_id: Number(item.audio_id || 0),
        mixsongid: Number(item.album_audio_id || item.audio_id || item.mixsongid || 0),
        cover: item.album_info ? item.album_info.sizable_cover?.replace('{size}', '400') : '',
      };
    });

    res.json({ code: 0, success: true, data: songs, total: body.data.total || 0 });
  } catch (err) {
    res.status(500).json({ code: 500, error: `搜索请求失败: ${err.message}` });
  }
});

// 2. 获取播放 URL
router.get('/api/song/url', async (req, res) => {
  try {
    const { hash, album_audio_id, songname, singername } = req.query;
    if (!hash) return res.status(400).json({ code: 400, error: '缺少 hash 参数' });

    // 正常路径：优先用 hash + album_audio_id
    const best = await resolveBestUrl(hash, album_audio_id);
    if (best) return res.json({ code: 0, ...best });

    // 兜底：历史/收藏里只有旧 hash 没有 album_audio_id，用歌名+歌手重新搜索拿最新可播链接
    // 酷狗播放接口必须带 album_audio_id(mixsongid)，历史/收藏旧的记录没有存这个字段
    if (songname) {
      const keyword = singername ? `${songname} ${singername}` : songname;
      const found = await findSongByKeyword(keyword);
      if (found && found.mixsongid) {
        const fallbackBest = await resolveBestUrl(found.hash, found.mixsongid);
        if (fallbackBest) {
          console.log('[song/url] 老记录已用歌名搜索兜底:', songname, singername, '->', found.hash?.slice(0, 16));
          return res.json({ code: 0, ...fallbackBest, fallback: true, resolved: found });
        }
      }
    }

    res.json({ code: 1001, error_code: 1001, error: '未找到可用播放链接，可能需要 VIP' });
  } catch (err) {
    res.status(500).json({ code: 500, error: `获取播放链接失败: ${err.message}` });
  }
});

// 3. 代理音频流
router.get('/api/stream', async (req, res) => {
  try {
    const { url, hash, name, album_audio_id } = req.query;
    let audioUrl = url;
    let isEncrypted = false;
    let ext = 'mp3';

    if (!audioUrl && hash) {
      const best = await resolveBestUrl(hash, album_audio_id);
      if (!best) return res.status(404).json({ code: 1001, error: '未找到可用音频' });
      audioUrl = best.url;
      isEncrypted = best.isEncrypted;
      ext = best.ext;
    }

    if (!isEncrypted) isEncrypted = /\.mgg(?:\?|$)/.test(audioUrl.toLowerCase());
    if (!ext) {
      const m = audioUrl.split('?')[0].toLowerCase().match(/\.([a-zA-Z0-9]{2,6})$/);
      ext = m ? m[1] : 'mp3';
    }

    if (isEncrypted) {
      const dl = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 120000, proxy: false });
      const rawExt = ext === 'mgg' ? 'ogg' : ext;
      const dec = decryptQmcFile(dl.data, rawExt);
      res.set({ 'Content-Type': dec.mime, 'Cache-Control': 'public, max-age=3600' });
      return res.send(dec.data);
    }

    const upHeaders = {};
    if (req.headers.range) upHeaders.Range = req.headers.range;
    if (req.headers['user-agent']) upHeaders['User-Agent'] = req.headers['user-agent'];
    const stream = await axios.get(audioUrl, { responseType: 'stream', timeout: 120000, proxy: false, headers: upHeaders });
    res.set({
      'Content-Type': stream.headers['content-type'] || getMimeType(ext),
      'Cache-Control': 'public, max-age=3600',
      'Accept-Ranges': 'bytes',
    });
    if (stream.status === 206) res.status(206);
    if (stream.headers['content-length']) res.set('Content-Length', stream.headers['content-length']);
    if (stream.headers['content-range']) res.set('Content-Range', stream.headers['content-range']);
    stream.data.on('error', () => { try { res.destroy(); } catch (e) {} });
    req.on('close', () => { if (!res.writableEnded) { try { stream.data.destroy(); } catch (e) {} } });
    stream.data.pipe(res);
  } catch (err) {
    res.status(500).json({ code: 500, error: `音频流获取失败: ${err.message}` });
  }
});

// 4. 下载歌曲
router.get('/api/download', async (req, res) => {
  try {
    const { hash, name, album_audio_id } = req.query;
    if (!hash) return res.status(400).json({ code: 400, error: '缺少 hash 参数' });

    const best = await resolveBestUrl(hash, album_audio_id);
    if (!best) return res.status(404).json({ code: 1001, error: '未找到可用链接' });

    let fileData, finalExt = best.ext;
    if (best.isEncrypted) {
      const dl = await axios.get(best.url, { responseType: 'arraybuffer', timeout: 120000, proxy: false });
      const dec = decryptQmcFile(dl.data, best.ext === 'mgg' ? 'ogg' : best.ext);
      fileData = dec.data; finalExt = dec.ext;
    } else {
      const dl = await axios.get(best.url, { responseType: 'arraybuffer', timeout: 120000, proxy: false });
      fileData = Buffer.from(dl.data);
    }

    const filename = `${name || hash}.${finalExt}`;
    res.set({ 'Content-Type': getMimeType(finalExt), 'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"` });
    res.send(fileData);
  } catch (err) {
    res.status(500).json({ code: 500, error: `下载失败: ${err.message}` });
  }
});

// 5. 登录状态
router.get('/api/status', async (req, res) => {
  try {
    const session = getSession();
    if (!session.token || !session.userid) return res.json({ code: 0, logged: false });

    const profile = await callModule('./module/user_detail', {});
    if (profile.status === 1 && profile.data) {
      return res.json({ code: 0, logged: true, nickname: profile.data.nickname || '', avatar: profile.data.avatar || '', userid: session.userid });
    }
    if (profile.error_code === 20018) {
      return res.json({ code: 0, logged: false, reason: '登录已过期，请重新扫码' });
    }
    res.json({ code: profile.error_code || 0, logged: false, reason: errorMsg(profile.error_code, '获取用户信息失败') });
  } catch (err) {
    res.status(500).json({ code: 500, error: `状态检查失败: ${err.message}` });
  }
});

// 6. 生成微信登录二维码
router.get('/api/login/wx/create', async (req, res) => {
  try {
    const result = await callModule('./module/login_wx_create', { timestamp: Date.now() });
    if (result.uuid && result.qrcode) {
      const session = getSession();
      session.pendingWxUuid = result.uuid;
      saveSession(session);
      return res.json({ code: 0, success: true, uuid: result.uuid, qrcode: result.qrcode.qrcodeurl || '', qrBase64: result.qrcode.qrcodebase64 || '' });
    }
    res.json({ code: result.error_code || 1001, error: '生成二维码失败' });
  } catch (err) {
    res.status(500).json({ code: 500, error: `二维码生成失败: ${err.message}` });
  }
});

// 7. 检查微信扫码状态
router.get('/api/login/wx/check', async (req, res) => {
  try {
    const session = getSession();
    const uuid = session.pendingWxUuid;
    console.log('[wx-check] uuid:', uuid);
    if (!uuid) return res.status(400).json({ code: 400, error: '未初始化登录，请先点击登录按钮' });

    const result = await callModule('./module/login_wx_check', { uuid, timestamp: Date.now() });
    const status = Number(result.wx_errcode || result.errcode || -1);
    console.log('[wx-check] result:', JSON.stringify(result).slice(0, 300));

    if (status === 405 && result.wx_code) {
      const loginResult = await callModule('./module/login_openplat', { code: result.wx_code });
      if (loginResult.status === 1 && loginResult.data) {
        const data = loginResult.data;
        if (data.token) session.cookies.token = String(data.token);
        if (data.userid) session.cookies.userid = String(data.userid);
        if (data.t1) session.cookies.t1 = String(data.t1);
        if (data.vip_type !== undefined) session.cookies.vip_type = String(data.vip_type);
        session.token = session.cookies.token || '';
        session.userid = session.cookies.userid || '';
        session.lastLoginAt = new Date().toISOString();
        saveSession(session);

        // 注册设备获取 dfid（使用正确的模块路径）
        try {
          await registerDeviceId(session, true);
        } catch(e) { console.error('[register/dev] error:', e.message); }

        // 登录成功后自动领取每日 VIP
        autoClaimVip().then(r => { if (r.ok) console.log('[vip] 微信登录后自动领取成功'); });

        const profile = await getUserProfile().catch(() => ({ ok: false }));
        return res.json({ code: 0, success: true, logged: true, nickname: profile?.ok ? profile.nickname : (data.nickname || '') });
      }
      return res.json({ code: loginResult.error_code || 1002, error: errorMsg(loginResult.error_code, '登录失败，请重试') });
    }

    if (status === 402 || status === 403) {
      return res.json({ code: 1003, expired: true, error: '二维码已过期，请重新点击登录' });
    }

    res.json({ code: 0, success: false, status, waiting: status !== 405 });
  } catch (err) {
    res.status(500).json({ code: 500, error: `登录检查失败: ${err.message}` });
  }
});

// 6b. 生成酷狗 App 扫码登录二维码（手机端扫码更方便）
router.get('/api/login/qr/create', async (req, res) => {
  try {
    const keyResult = await callModule('./module/login_qr_key', {});
    const key = keyResult?.data?.qrcode;
    if (!key) return res.json({ code: 1001, error: '生成二维码失败' });

    // 生成 H5 确认页二维码图
    let qrBase64 = '';
    try {
      const qrImg = await require('./module/login_qr_create')({ key, qrimg: 1 }, createRequest);
      // 模块返回可能自带 data:image/png;base64, 前缀，统一剥掉只留纯 base64
      qrBase64 = String(qrImg?.body?.data?.base64 || '').replace(/^data:image\/[a-z0-9+.-]+;base64,/i, '');
    } catch (e) { console.warn('[qr] 生成图片失败:', e.message); }

    const session = getSession();
    session.pendingQrKey = key;
    saveSession(session);
    return res.json({ code: 0, success: true, key, qrBase64 });
  } catch (err) {
    res.status(500).json({ code: 500, error: `二维码生成失败: ${err.message}` });
  }
});

// 6c. 检查酷狗 App 扫码状态
router.get('/api/login/qr/check', async (req, res) => {
  try {
    const session = getSession();
    if (!session.pendingQrKey) return res.status(400).json({ code: 400, error: '未初始化登录，请先点击登录按钮' });

    const result = await callModule('./module/login_qr_check', { key: session.pendingQrKey });
    const status = Number(result?.data?.status ?? -1);
    console.log('[qr-check] status:', status);

    if (status === 4) {
      // login_qr_check 在 status=4 时会向 cookie 注入 token/userid
      session.token = session.cookies.token || '';
      session.userid = session.cookies.userid || '';
      session.lastLoginAt = new Date().toISOString();
      session.pendingQrKey = '';
      saveSession(session);

      try { await registerDeviceId(session, true); } catch(e) { console.error('[qr] register dev:', e.message); }
      autoClaimVip().then(r => { if (r.ok) console.log('[vip] 扫码登录后自动领取成功'); });

      const profile = await getUserProfile().catch(() => ({ ok: false }));
      return res.json({ code: 0, success: true, logged: true, nickname: profile?.ok ? profile.nickname : '' });
    }
    if (status === 0) return res.json({ code: 1003, expired: true, error: '二维码已过期，请重新点击生成' });

    res.json({ code: 0, success: false, status, waiting: status === 1 || status === 2 });
  } catch (err) {
    res.status(500).json({ code: 500, error: `扫码登录检查失败: ${err.message}` });
  }
});

// 6c. 手机验证码登录 - 发送验证码
router.post('/api/login/sms/send', async (req, res) => {
  try {
    const { mobile } = req.body || {};
    if (!/^1\d{10}$/.test(String(mobile || ''))) {
      return res.json({ code: 400, error: '请输入正确的手机号' });
    }
    const s = await callModule('./module/captcha_sent', { mobile });
    if (s.status === 1) return res.json({ code: 0, success: true, msg: '验证码已发送' });
    res.json({ code: s.error_code || 1001, error: errorMsg(s.error_code, '验证码发送失败') });
  } catch (err) {
    res.status(500).json({ code: 500, error: `验证码发送失败: ${err.message}` });
  }
});

// 6d. 手机验证码登录 - 提交验证码
router.post('/api/login/sms/login', async (req, res) => {
  try {
    const { mobile, code } = req.body || {};
    if (!/^1\d{10}$/.test(String(mobile || '')) || !String(code || '').trim()) {
      return res.json({ code: 400, error: '请输入正确的手机号和验证码' });
    }
    const loginRes = await callModule('./module/login_cellphone', { mobile, code: String(code).trim() });
    if (loginRes.status === 1 && (loginRes.data?.token || loginRes.data?.userid)) {
      const session = getSession();
      session.token = session.cookies.token || '';
      session.userid = session.cookies.userid || '';
      session.lastLoginAt = new Date().toISOString();
      saveSession(session);
      try { await registerDeviceId(session, true); } catch(e) { console.warn('[sms] 设备:', e.message); }
      autoClaimVip().then(r => { if (r.ok) console.log('[vip] 短信登录后自动领取成功'); });
      const profile = await getUserProfile().catch(() => ({ ok: false }));
      return res.json({ code: 0, success: true, logged: true, nickname: profile?.ok ? profile.nickname : '' });
    }
    res.json({ code: 0, success: false, error: loginRes.error_code ? errorMsg(loginRes.error_code, '登录失败') : '登录失败' });
  } catch (err) {
    res.status(500).json({ code: 500, error: `登录失败: ${err.message}` });
  }
});

// 6e. Cookie/Token 直接登录（高级用户：从酷狗 App 抓取的 token）
router.post('/api/login/cookie', async (req, res) => {
  try {
    const { token, userid, t1, vip_type, vip_token, dfid, token2 } = req.body || {};
    const _token = String(token || token2 || '').trim();
    const _userid = String(userid || '').trim();
    if (!_token || !_userid) return res.json({ code: 400, error: '请提供 token 与 userid' });

    // 备份登录前的设备会话，失败时原样恢复
    const backupCookies = { ...mergeDevice(getSession()).cookies };
    const session = getSession();
    mergeDevice(session);
    session.cookies.token = _token;
    session.cookies.userid = _userid;
    if (t1) session.cookies.t1 = String(t1);
    if (vip_type !== undefined) session.cookies.vip_type = String(vip_type);
    if (vip_token) session.cookies.vip_token = String(vip_token);
    if (dfid) session.cookies.dfid = String(dfid);
    session.token = _token;
    session.userid = _userid;
    saveSession(session);

    const profile = await getUserProfile().catch(() => ({ ok: false }));
    if (!profile.ok) {
      // 凭证无效：恢复原会话（保留设备/dfid，仅丢到刚写入的登录凭据）
      const restored = mergeDevice(getSession());
      restored.cookies = { ...(backupCookies || {}) };
      restored.token = '';
      restored.userid = '';
      if (!restored.cookies.dfid && restored.device.dfid) restored.cookies.dfid = restored.device.dfid;
      saveSession(restored);
      return res.json({ code: 0, success: false, error: profile.reason || '凭证无效，请检查 token/userid' });
    }

    try { await registerDeviceId(session, true); } catch(e) { console.warn('[cookie] 设备:', e.message); }
    autoClaimVip().then(r => { if (r.ok) console.log('[vip] Cookie 登录后自动领取成功'); });
    return res.json({ code: 0, success: true, logged: true, nickname: profile.nickname || '' });
  } catch (err) {
    res.status(500).json({ code: 500, error: `登录失败: ${err.message}` });
  }
});

// 8. VIP 状态
router.get('/api/vip/status', async (req, res) => {
  try {
    const session = getSession();
    if (!session.token || !session.userid) return res.json({ code: 0, vip: false });

    const vipInfo = await callModuleSafe('./module/youth_vip', {}, '查询 VIP 状态失败，请稍后再试');
    if (vipInfo.status === 1 && vipInfo.data) {
      const data = vipInfo.data;
      const remainHours = data.remain_vip_hour || 0;
      const isVip = remainHours > 0;
      return res.json({
        code: 0, vip: isVip,
        remainHours,
        totalHours: data.total || 0,
        doneCount: data.done || 0,
        remainCount: data.remain || 0,
        awardHours: data.award_vip_hour || 0,
      });
    }
    if (vipInfo.error_code === 20018) {
      return res.json({ code: 0, vip: false, expired: true });
    }
    res.json({ code: vipInfo.error_code || 1004, vip: false, error: vipInfo.error_msg || '获取 VIP 状态失败' });
  } catch (err) {
    res.status(500).json({ code: 500, error: `VIP 状态查询失败: ${err.message}` });
  }
});

// 9. 领取每日 VIP
router.post('/api/vip/claim', async (req, res) => {
  try {
    const session = getSession();
    if (!session.token || !session.userid) return res.status(401).json({ code: 401, error: '未登录，请先扫码登录' });

    // 先检查是否已经是 VIP（done>0 表示今天已领过）
    const vipCheck = await callModuleSafe('./module/youth_vip', {}, '查询 VIP 状态失败，请稍后再试');
    console.log('[vip/claim] 预检查:', JSON.stringify(vipCheck).slice(0, 160));
    if (vipCheck.error_code === 20018) {
      return res.status(401).json({ code: 401, expired: true, error: '登录已过期，请重新扫码登录' });
    }
    if (vipCheck.status === 1 && vipCheck.data?.done > 0) {
      return res.json({
        code: 0, success: false, alreadyClaimed: true,
        message: `今天已领取（剩余 ${vipCheck.data.remain_vip_hour || 0} 小时，还可领 ${vipCheck.data.remain || 0} 次）`,
        remainHours: vipCheck.data.remain_vip_hour || 0,
        remainCount: vipCheck.data.remain || 0,
      });
    }
    // vipCheck 查询失败（网络/风控）不阻塞，继续尝试领取
    if (vipCheck.status !== 1) {
      console.warn('[vip] 状态查询失败，直接尝试领取:', vipCheck.error_msg);
      if (vipCheck.error_code === 502) {
        return res.json({ code: 502, cooldown: true, coolSeconds: 6, error: '操作过于频繁，请稍等几秒再试' });
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const r1 = await callModuleSafe('./module/youth_day_vip', { receive_day: today }, '网络异常，请稍后重试');
    console.log('[vip/claim] youth_day_vip:', JSON.stringify(r1).slice(0, 200));

    if (r1.status === 1) {
      let r2 = null;
      try { r2 = await callModule('./module/youth_day_vip_upgrade', {}); } catch {}
      return res.json({ code: 0, success: true, message: 'VIP 领取成功！', dayVip: r1.data, upgradeVip: r2?.data });
    }

    const msg = r1.error_msg || errorMsg(r1.error_code, '领取失败，请稍后再试');
    const cooldown = r1.error_code === 502;
    return res.json({ code: r1.error_code || 1005, error_code: r1.error_code, error: msg, cooldown, coolSeconds: cooldown ? 6 : 0 });
  } catch (err) {
    res.status(500).json({ code: 500, error: `VIP 领取失败: ${callErrorText(err, '请稍后再试')}` });
  }
});

// 10. 歌词
router.get('/api/lyric', async (req, res) => {
  try {
    const { hash, album_audio_id } = req.query;
    if (!hash) return res.status(400).json({ code: 400, error: '缺少 hash 参数' });

    const sr = await callModule('./module/search_lyric', { hash, album_audio_id: album_audio_id || 0, keywords: '' });
    if ((sr.status === 1 || sr.status === 200) && sr.candidates && sr.candidates.length > 0) {
      const c = sr.candidates[0];
      const lr = await callModule('./module/lyric', { id: c.id, accesskey: c.accesskey, fmt: 'lrc', decode: true });
      return res.json({ code: 0, success: true, lyric: lr.decodeContent || lr.content || '' });
    }
    res.json({ code: 0, success: false, msg: '未找到歌词' });
  } catch (err) {
    res.status(500).json({ code: 500, error: `歌词获取失败: ${err.message}` });
  }
});

// ===== 核心逻辑 =====

const songUrlMod = require('./module/song_url');

// 按歌名+歌手搜索，命中第一条即返回 (mixsongid + hash + 元信息)。
// 酷狗播放接口必须带 album_audio_id(mixsongid)，历史/收藏里只存了 hash，播放时靠这个兜底补回。
async function findSongByKeyword(keyword) {
  try {
    const resp = await axios.get('http://mobilecdn.kugou.com/api/v3/search/song', {
      params: { format: 'json', keyword, pagesize: 10, showtype: 1 },
      timeout: 10000, proxy: false, validateStatus: () => true,
    });
    const body = resp.data || {};
    const list = body?.data?.info || [];
    for (const item of list) {
      const mixsongid = Number(item.album_audio_id || item.audio_id || item.mixsongid || 0);
      if (item.hash && mixsongid) {
        return {
          hash: String(item.hash).toUpperCase(),
          mixsongid,
          album_audio_id: Number(item.album_audio_id || 0),
          songname: item.songname || '',
          singername: item.singername || '',
          album_name: item.album_name || '',
          duration: item.duration || 0,
          sqhash: (item.sqhash || '').toUpperCase(),
          hash_320: (item['320hash'] || '').toUpperCase(),
        };
      }
    }
  } catch (e) {
    console.warn('[findSongByKeyword] failed', keyword, e.message);
  }
  return null;
}

async function resolveBestUrl(hash, albumAudioId, opts = {}) {
  const qualities = ['viper_clear', 'viper_atmos', 'viper_tape', 'flac', 'high', '320', '128'];
  let best = null;
  const session = await ensureDevice();
  console.log('[resolveBestUrl] hash:', hash?.slice(0,16), 'albumAudioId:', albumAudioId, 'hasDfid:', !!session.cookies.dfid, 'cookies keys:', Object.keys(session.cookies).join(','));

  const tryQuality = async (q, extra = {}) => {
    const params = { hash, quality: q, cookie: session.cookies };
    if (albumAudioId) params.album_audio_id = albumAudioId;
    else params.album_audio_id = 0;
    if (opts.free_part || extra.free_part) params.free_part = 1;
    return songUrlMod(params, createRequest);
  };

  for (const q of qualities) {
    try {
      const result = await tryQuality(q);
      const body = result?.body || result;
      console.log(`[resolveBestUrl] q=${q} status=${body?.status} hasUrl=${!!(body?.url || body?.data?.url)} hasBackup=${!!(body?.backupUrl || body?.data?.backupUrl)}`);
      if (body.status !== 1) continue;

      const data = body.data || body;
      const urls = Array.isArray(data.url) ? data.url : (data.url ? [data.url] : []);
      const backupUrls = Array.isArray(data.backupUrl) ? data.backupUrl : (data.backupUrl ? [data.backupUrl] : []);
      const allUrls = urls.length > 0 ? urls : backupUrls;
      if (allUrls.length === 0) continue;

      const extName = data.extName || data.ext_name || 'mp3';
      const isEncrypted = /\.mgg(?:\?|$)/i.test(allUrls[0] || '');
      const bitrateMap = {
        viper_clear: 999, viper_atmos: 999, viper_tape: 320,
        flac: 999, high: 320, '320': 320, '128': 128,
      };

      const candidate = { url: allUrls[0], quality: q, bitrate: bitrateMap[q] || 128, isEncrypted, ext: extName, trial: false };
      if (!best || candidate.bitrate > best.bitrate || (candidate.bitrate === best.bitrate && !candidate.isEncrypted)) {
        best = candidate;
        if (best.bitrate >= 999 && !best.isEncrypted) break;
      }
    } catch { /* continue */ }
    if (best && best.bitrate >= 999 && !best.isEncrypted) break;
  }

  // 全曲不可用（VIP 锁定 / 未登录）时，尝试返回官方试听片段，保证"能播"
  if (!best && hash) {
    try {
      const ft = await tryQuality('128', { free_part: 1 });
      const fbody = ft?.body || ft;
      if (fbody.status === 1) {
        const data = fbody.data || fbody;
        const urls = Array.isArray(data.url) ? data.url : (data.url ? [data.url] : []);
        const backupUrls = Array.isArray(data.backupUrl) ? data.backupUrl : (data.backupUrl ? [data.backupUrl] : []);
        const allUrls = urls.length > 0 ? urls : backupUrls;
        if (allUrls.length > 0) {
          const isEncrypted = /\.mgg(?:\?|$)/i.test(allUrls[0] || '');
          best = { url: allUrls[0], quality: 'free', bitrate: 64, isEncrypted, ext: data.extName || data.ext_name || 'mp3', trial: true };
          console.log('[resolveBestUrl] 使用官方试听片段:', best.url.slice(0, 80));
        }
      }
    } catch { /* 忽略试听失败 */ }
  }

  return best;
}

// 11. 退出登录（保留设备标识，退出后仍可免费/试听）
router.post('/api/logout', async (req, res) => {
  try {
    const session = mergeDevice(getSession());
    for (const k of ['token', 'userid', 't1', 'vip_type', 'vip_token']) delete session.cookies[k];
    session.token = '';
    session.userid = '';
    session.pendingWxUuid = '';
    session.pendingQrKey = '';
    session.lastLoginAt = '';
    // 保留 dfid 与 device，避免退出后无法播放免费歌曲
    if (session.cookies.dfid) session.dfid = session.cookies.dfid;
    saveSession(session);
    res.json({ code: 0, success: true });
  } catch (err) {
    res.status(500).json({ code: 500, error: `退出失败: ${err.message}` });
  }
});

// 12. 收藏/取消收藏
router.post('/api/favorite', async (req, res) => {
  try {
    const { song, action } = req.body;
    if (!song || !song.hash) return res.status(400).json({ code: 400, error: '缺少歌曲信息' });
    if (action === 'remove') {
      const ok = getRecommend().removeFavorite(song.hash);
      return res.json({ code: 0, success: ok, msg: ok ? '已取消收藏' : '未在收藏列表' });
    }
    const ok = getRecommend().addFavorite(song);
    res.json({ code: 0, success: ok, msg: ok ? '收藏成功' : '已收藏过' });
  } catch (err) {
    res.status(500).json({ code: 500, error: `收藏失败: ${err.message}` });
  }
});

// 13. 获取收藏列表
router.get('/api/favorites', async (req, res) => {
  try {
    const favs = await getRecommend().getFavorites();
    res.json({ code: 0, data: favs, total: favs.length });
  } catch (err) {
    res.status(500).json({ code: 500, error: `获取收藏失败: ${err.message}` });
  }
});

// 14. 获取播放历史
router.get('/api/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const history = await getRecommend().getHistory(limit);
    res.json({ code: 0, data: history, total: history.length });
  } catch (err) {
    res.status(500).json({ code: 500, error: `获取历史失败: ${err.message}` });
  }
});

// 15. 记录播放
router.post('/api/record-play', async (req, res) => {
  try {
    const { song, play_duration } = req.body;
    if (!song || !song.hash) return res.status(400).json({ code: 400, error: '缺少歌曲信息' });
    getRecommend().recordPlay(song, play_duration);
    res.json({ code: 0, success: true });
  } catch (err) {
    res.status(500).json({ code: 500, error: `记录播放失败: ${err.message}` });
  }
});

// 16. AI 猜你喜欢
router.get('/api/recommend', async (req, res) => {
  try {
    const rec = await getRecommend().generateRecommendations();
    res.json({ code: 0, ...rec });
  } catch (err) {
    res.status(500).json({ code: 500, error: `推荐生成失败: ${err.message}` });
  }
});

// 启动时异步预注册设备 dfid（未登录也能播免费/试听歌曲）
setTimeout(() => {
  ensureDevice().then(s => {
    console.log('[device] startup dfid:', s.cookies.dfid ? 'ready(' + s.cookies.dfid.slice(0, 8) + '...)' : '待重试');
  }).catch(e => console.warn('[device] 启动注册异常:', e.message));
}, 3000);

module.exports = router;
