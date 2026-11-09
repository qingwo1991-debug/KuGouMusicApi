/**
 * KuGou Music Web App
 * 集成搜索、播放、下载、登录、VIP领取的Web服务
 */

const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const express = require('express');
const { decryptQmcFile } = require('./util/qmc_decrypt');

// Session 存储
const sessionPath = path.join(__dirname, '.kugou', 'session.json');
const downloadDir = path.join(__dirname, '.kugou', 'downloads');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
ensureDir(path.dirname(sessionPath));
ensureDir(downloadDir);

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============ KuGou API 调用 ============

const KUGOU_BASE = 'http://127.0.0.1:5301';

async function kugouApi(endpoint, params = {}, { method = 'GET', cookie = {} } = {}) {
  const url = `${KUGOU_BASE}${endpoint}`;
  const headers = {};
  const cookieStr = Object.entries(cookie)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  if (cookieStr) headers['Authorization'] = cookieStr;

  const opts = {
    method,
    headers,
    timeout: 20000,
    proxy: false,
    validateStatus: () => true,
  };

  if (method === 'GET') {
    opts.params = params;
  } else {
    opts.data = params;
  }

  const resp = await axios(url, opts);
  return resp.data || {};
}

function getSession() {
  return readJson(sessionPath, {
    cookies: {},
    token: '',
    userid: '',
    dfid: '',
    lastLoginAt: '',
  });
}

function saveSession(session) {
  writeJson(sessionPath, session);
}

function applySetCookie(session, headers) {
  const list = (headers && headers['set-cookie']) || [];
  for (const line of list) {
    const first = String(line).split(';')[0] || '';
    const idx = first.indexOf('=');
    if (idx <= 0) continue;
    const k = first.slice(0, idx).trim();
    const v = first.slice(idx + 1).trim();
    session.cookies[k] = v;
  }
  if (session.cookies.token) session.token = session.cookies.token;
  if (session.cookies.userid) session.userid = String(session.cookies.userid);
  if (session.cookies.dfid) session.dfid = session.cookies.dfid;
}

async function apiCall(endpoint, params = {}, { auth = false, method = 'GET' } = {}) {
  const session = getSession();
  const cookie = auth
    ? { ...session.cookies, token: session.token, userid: session.userid, dfid: session.dfid }
    : session.cookies;

  const resp = await axios(`${KUGOU_BASE}${endpoint}`, {
    method,
    params: method === 'GET' ? { ...params, ...cookie } : undefined,
    data: method === 'POST' ? { ...params, ...cookie } : undefined,
    headers: auth && session.token ? { Authorization: Object.entries(cookie).map(([k, v]) => `${k}=${v}`).join('; ') } : {},
    timeout: 20000,
    proxy: false,
    validateStatus: () => true,
  });

  applySetCookie(session, resp.headers || {});
  saveSession(session);
  return resp.data || {};
}

// ============ 音质优先级 ============

const QUALITY_PRIORITY = [
  { key: 'viper_clear', label: '无损+', bitrate: 999 },
  { key: 'viper_atmos', label: '杜比', bitrate: 999 },
  { key: 'viper_tape', label: '母带', bitrate: 320 },
  { key: 'flac', label: 'FLAC', bitrate: 999 },
  { key: 'high', label: '320K', bitrate: 320 },
  { key: '320', label: '320K', bitrate: 320 },
  { key: '128', label: '128K', bitrate: 128 },
];

// ============ 创建 Express 应用 ============

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Credentials': true,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// ============ API 路由 ============

// 1. 搜索歌曲
app.get('/api/search', async (req, res) => {
  try {
    const { keyword, page = 1, pagesize = 20 } = req.query;
    if (!keyword) return res.status(400).json({ error: '缺少关键词' });

    const result = await apiCall('/search', { keywords: keyword, page: parseInt(page), pagesize: parseInt(pagesize) });

    if (result.status === 1 && result.data && result.data.info) {
      const songs = result.data.info.map((item) => {
        const groups = Array.isArray(item.group) ? item.group : [];
        const hashes = [];
        const addHash = (h) => {
          if (h && !hashes.includes(String(h).toUpperCase())) hashes.push(String(h).toUpperCase());
        };
        addHash(item.sqhash);
        addHash(item['320hash']);
        addHash(item.hash);
        for (const g of groups) {
          addHash(g.sqhash);
          addHash(g['320hash']);
          addHash(g.hash);
        }

        return {
          songname: item.songname || '',
          singername: item.singername || '',
          album_name: item.album_name || '',
          duration: item.duration || 0,
          hash: (item.hash || '').toUpperCase(),
          sqhash: (item.sqhash || '').toUpperCase(),
          hash_320: (item['320hash'] || '').toUpperCase(),
          hashes,
          album_id: item.album_id || 0,
          mixsongid: item.mixsongid || item.audio_id || 0,
        };
      });

      return res.json({ success: true, data: songs, total: result.data.total || 0 });
    }

    res.json({ success: false, msg: result.error || '搜索失败' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. 获取歌曲 URL（优先高音质，避开加密）
app.get('/api/song/url', async (req, res) => {
  try {
    const { hash, album_audio_id } = req.query;
    if (!hash) return res.status(400).json({ error: '缺少 hash' });

    const bestUrl = await resolveBestUrl(hash, album_audio_id);
    if (bestUrl) {
      return res.json({ success: true, ...bestUrl });
    }

    res.json({ success: false, msg: '未找到可用链接' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. 代理音频流（解密或直接转发）
app.get('/api/stream', async (req, res) => {
  try {
    const { url, hash, name, album_audio_id } = req.query;

    let audioUrl = url;
    let isEncrypted = false;
    let ext = 'mp3';

    // 如果没有直接提供 URL，则获取
    if (!audioUrl && hash) {
      const best = await resolveBestUrl(hash, album_audio_id);
      if (!best) return res.status(404).json({ error: '未找到可用音频' });
      audioUrl = best.url;
      isEncrypted = best.isEncrypted;
      ext = best.ext;
    }

    // 检测是否加密
    const urlLower = audioUrl.toLowerCase();
    if (!isEncrypted) {
      isEncrypted = /\.mgg(?:\?|$)/.test(urlLower);
    }
    if (!ext) {
      const noQuery = urlLower.split('?')[0];
      const m = noQuery.match(/\.([a-zA-Z0-9]{2,6})$/);
      ext = m ? m[1] : 'mp3';
    }

    if (isEncrypted) {
      // 下载并解密
      console.log('[decrypt] downloading encrypted file:', audioUrl);
      const dlResp = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 120000, proxy: false });
      const rawExt = ext.toLowerCase().replace('mgg', 'ogg').replace('mflac', 'flac');
      const decrypted = decryptQmcFile(dlResp.data, rawExt);

      res.set({
        'Content-Type': decrypted.mime,
        'Content-Disposition': `inline; filename="${encodeURIComponent(name || 'audio')}.${decrypted.ext}"`,
        'Cache-Control': 'public, max-age=3600',
      });
      return res.send(decrypted.data);
    }

    // 直接代理流
    const streamResp = await axios.get(audioUrl, { responseType: 'stream', timeout: 120000, proxy: false });
    res.set({
      'Content-Type': streamResp.headers['content-type'] || getMimeType(ext),
      'Cache-Control': 'public, max-age=3600',
    });
    if (streamResp.headers['content-length']) {
      res.set('Content-Length', streamResp.headers['content-length']);
    }
    streamResp.data.pipe(res);
  } catch (err) {
    console.error('[stream error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. 下载歌曲
app.get('/api/download', async (req, res) => {
  try {
    const { hash, name, album_audio_id } = req.query;
    if (!hash) return res.status(400).json({ error: '缺少 hash' });

    const best = await resolveBestUrl(hash, album_audio_id);
    if (!best) return res.status(404).json({ error: '未找到可用链接' });

    // 下载文件
    let fileData;
    if (best.isEncrypted) {
      const dlResp = await axios.get(best.url, { responseType: 'arraybuffer', timeout: 120000, proxy: false });
      const rawExt = best.ext.toLowerCase().replace('mgg', 'ogg').replace('mflac', 'flac');
      const decrypted = decryptQmcFile(dlResp.data, rawExt);
      fileData = decrypted.data;
      best.ext = decrypted.ext;
    } else {
      const dlResp = await axios.get(best.url, { responseType: 'arraybuffer', timeout: 120000, proxy: false });
      fileData = Buffer.from(dlResp.data);
    }

    const filename = `${name || hash}.${best.ext}`;
    res.set({
      'Content-Type': getMimeType(best.ext),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
    });
    return res.send(fileData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. 登录状态
app.get('/api/status', async (req, res) => {
  try {
    const session = getSession();
    if (!session.token || !session.userid) {
      return res.json({ logged: false });
    }
    const profile = await apiCall('/user/detail', { token: session.token, userid: session.userid }, { auth: true });
    if (profile.status === 1 && profile.data) {
      return res.json({
        logged: true,
        nickname: profile.data.nickname || '',
        avatar: profile.data.avatar || '',
        userid: session.userid,
      });
    }
    res.json({ logged: false });
  } catch {
    res.json({ logged: false });
  }
});

// 6. 生成微信登录二维码
app.get('/api/login/wx/create', async (req, res) => {
  try {
    const result = await apiCall('/login/wx/create', { timestamp: Date.now() });
    if (result.uuid && result.qrcode) {
      const session = getSession();
      session.pendingWxUuid = result.uuid;
      saveSession(session);
      return res.json({ success: true, uuid: result.uuid, qrcode: result.qrcode.qrcodeurl || '', qrBase64: result.qrcode.qrcodebase64 || '' });
    }
    res.json({ success: false, msg: '生成二维码失败' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. 检查微信扫码状态
app.get('/api/login/wx/check', async (req, res) => {
  try {
    const session = getSession();
    const uuid = session.pendingWxUuid;
    if (!uuid) return res.status(400).json({ error: '未初始化登录' });

    const result = await apiCall('/login/wx/check', { uuid, timestamp: Date.now() });
    const status = Number(result.wx_errcode || result.errcode || -1);

    if (status === 405 && result.wx_code) {
      // 已扫码，进行登录
      const loginResult = await apiCall(
        '/login/openplat',
        { code: result.wx_code },
        { auth: true, method: 'POST' }
      );
      if (loginResult.status === 1 && loginResult.data) {
        const data = loginResult.data;
        if (data.token) session.cookies.token = String(data.token);
        if (data.userid) session.cookies.userid = String(data.userid);
        if (data.t1) session.cookies.t1 = String(data.t1);
        session.token = session.cookies.token || '';
        session.userid = session.cookies.userid || '';
        session.lastLoginAt = new Date().toISOString();
        saveSession(session);

        // 注册设备
        try {
          await apiCall('/register/dev', { token: session.token, userid: session.userid }, { auth: true });
        } catch {}

        return res.json({
          success: true,
          logged: true,
          nickname: data.nickname || '',
        });
      }
    }

    if (status === 402 || status === 403) {
      return res.json({ success: false, expired: true });
    }

    res.json({ success: false, status, waiting: status !== 405 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. 领取每日 VIP
app.post('/api/vip/claim', async (req, res) => {
  try {
    const session = getSession();
    if (!session.token || !session.userid) {
      return res.status(401).json({ error: '未登录' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const r1 = await apiCall('/youth/day/vip', { token: session.token, userid: session.userid, receive_day: today }, { auth: true, method: 'POST' });

    let r2 = null;
    try {
      r2 = await apiCall('/youth/day/vip/upgrade', { token: session.token, userid: session.userid }, { auth: true, method: 'POST' });
    } catch {}

    res.json({ success: true, dayVip: r1, upgradeVip: r2 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. 获取 VIP 状态
app.get('/api/vip/status', async (req, res) => {
  try {
    const session = getSession();
    if (!session.token || !session.userid) {
      return res.json({ vip: false });
    }
    const vipInfo = await apiCall('/user/vip/detail', { token: session.token, userid: session.userid }, { auth: true });
    const isVip = vipInfo.status === 1 && vipInfo.data && vipInfo.data.vip_type > 0;
    res.json({ vip: isVip, info: vipInfo.data || null });
  } catch {
    res.json({ vip: false });
  }
});

// 10. 歌词
app.get('/api/lyric', async (req, res) => {
  try {
    const { keyword, album_audio_id } = req.query;
    if (!keyword && !album_audio_id) return res.status(400).json({ error: '缺少参数' });

    // 先搜索歌词
    const searchResult = await apiCall('/search/lyric', { keywords: keyword || '', page: 1, pagesize: 1 });
    if (searchResult.status === 1 && searchResult.data && searchResult.data.info && searchResult.data.info.length > 0) {
      const id = searchResult.data.info[0].id;
      const lyricResult = await apiCall('/lyric', { id });
      return res.json({ success: true, lyric: lyricResult.content || lyricResult.lyric || '' });
    }
    res.json({ success: false, msg: '未找到歌词' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ 辅助函数 ============

async function resolveBestUrl(hash, albumAudioId) {
  const qualities = ['viper_clear', 'viper_atmos', 'viper_tape', 'flac', 'high', '320', '128'];
  let best = null;

  for (const q of qualities) {
    for (const endpoint of ['/song/url', '/song/url/new']) {
      try {
        const params = { hash, quality: q };
        if (albumAudioId) params.album_audio_id = albumAudioId;

        const result = await apiCall(endpoint, params, { auth: true });
        if (!result || result.status !== 1) continue;

        const candidate = extractUrl(result, q);
        if (candidate && (!best || candidate.bitrate > best.bitrate)) {
          best = candidate;
          if (best.bitrate >= 999) break; // 最高音质，直接返回
        }
      } catch {}
    }
    if (best && best.bitrate >= 999) break;
  }

  return best;
}

function extractUrl(result, quality) {
  const data = result.data || result;
  if (!data) return null;

  // /song/url 格式
  if (data.url) {
    const url = Array.isArray(data.url) ? data.url[0] : data.url;
    if (!url) return null;
    return parseCandidate(url, quality, data);
  }

  // /song/url/new 格式
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item.url) {
        return parseCandidate(item.url, quality, item);
      }
    }
  }

  return null;
}

function parseCandidate(url, quality, rawData) {
  const bitrateMap = {
    viper_clear: 999,
    viper_atmos: 999,
    viper_tape: 320,
    flac: 999,
    high: 320,
    '320': 320,
    '128': 128,
  };

  const ext = detectExt(url, rawData);
  const isEncrypted = /\.mgg(?:\?|$)/i.test(url);

  // 非加密优先
  if (isEncrypted) {
    return { url, quality, bitrate: (bitrateMap[quality] || 128) - 10, isEncrypted: true, ext };
  }

  return { url, quality, bitrate: bitrateMap[quality] || 128, isEncrypted: false, ext };
}

function detectExt(url, data) {
  const lower = url.toLowerCase();
  if (lower.includes('.mp3')) return 'mp3';
  if (lower.includes('.flac')) return 'flac';
  if (lower.includes('.ogg')) return 'ogg';
  if (lower.includes('.m4a')) return 'm4a';
  if (lower.includes('.mgg')) return 'mgg';
  if (lower.includes('.wav')) return 'wav';
  if (data.extname) return data.extname;
  if (data.ext) return data.ext;
  return 'mp3';
}

function getMimeType(ext) {
  const mimes = {
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    wav: 'audio/x-wav',
    mgg: 'audio/ogg',
  };
  return mimes[ext] || 'audio/mpeg';
}

// ============ 启动服务 ============

const PORT = process.env.WEB_PORT || 5301;

// 如果 KuGouMusicApi 已在同一进程运行，则只添加路由
// 否则，假设 API 已经在 5301 运行，本文件需要不同端口
// 这里使用 WEB_PORT 环境变量区分

module.exports = app;

if (require.main === module) {
  // 作为独立服务启动时
  const webPort = process.env.WEB_PORT || 5302; // 默认 5302，避免与 KuGouMusicApi 冲突
  app.listen(webPort, () => {
    console.log(`KuGou Music Web running at http://127.0.0.1:${webPort}`);
  });
}
