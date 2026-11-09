#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const axios = require('axios');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
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

function sanitizeName(s) {
  return String(s || 'unknown').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
}

function sanitizePathSegment(s) {
  const v = String(s || 'unknown').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return v || 'unknown';
}

function encodeAlistPath(p) {
  return String(p)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

function inferExtFromUrl(url) {
  try {
    const noQuery = String(url || '').split('?')[0];
    const m = noQuery.match(/\.([a-zA-Z0-9]{2,6})$/);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_()[\]{}'"`~!@#$%^&*+=|\\/:;,.<>?]/g, '');
}

class KugouAssistant {
  constructor(opts) {
    this.baseUrl = opts.baseUrl || 'http://127.0.0.1:5301';
    this.statePath = opts.statePath;
    this.downloadDir = opts.downloadDir;
    this.state = readJson(this.statePath, {
      cookies: {},
      token: '',
      userid: '',
      dfid: '',
      pendingWxUuid: '',
      pendingWxQrUrl: '',
      lastLoginAt: '',
      syncedTracks: {},
    });
  }

  save() {
    if (!this.state.syncedTracks || typeof this.state.syncedTracks !== 'object') {
      this.state.syncedTracks = {};
    }
    writeJson(this.statePath, this.state);
  }

  cookieHeader() {
    return Object.entries(this.state.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  applySetCookie(headers) {
    const list = (headers && headers['set-cookie']) || [];
    for (const line of list) {
      const first = String(line).split(';')[0] || '';
      const idx = first.indexOf('=');
      if (idx <= 0) continue;
      const k = first.slice(0, idx).trim();
      const v = first.slice(idx + 1).trim();
      this.state.cookies[k] = v;
    }
    this.hydrateFromCookies();
  }

  hydrateFromCookies() {
    const c = this.state.cookies;
    if (c.token) this.state.token = c.token;
    if (c.userid) this.state.userid = String(c.userid);
    if (c.dfid) this.state.dfid = c.dfid;
  }

  mergeBodyLoginData(body) {
    const data = body && body.data;
    if (!data || typeof data !== 'object') return;
    const keys = ['token', 'userid', 't1', 'vip_type', 'vip_token'];
    for (const k of keys) {
      if (data[k] !== undefined && data[k] !== null) {
        this.state.cookies[k] = String(data[k]);
      }
    }
    this.hydrateFromCookies();
  }

  async callLocal(endpoint, params = {}, { auth = false, timeout = 15000 } = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {};
    if (auth) {
      const cookie = this.cookieHeader();
      if (cookie) headers.Authorization = cookie;
    }

    const resp = await axios.get(url, {
      params,
      headers,
      timeout,
      proxy: false,
      validateStatus: () => true,
    });

    this.applySetCookie(resp.headers || {});
    return resp;
  }

  ensureAuthParams(extra = {}) {
    return Object.assign({}, extra, {
      token: this.state.token,
      userid: this.state.userid,
      dfid: this.state.dfid,
    });
  }

  async wxLoginInit() {
    const resp = await this.callLocal('/login/wx/create', { timestamp: Date.now() }, { auth: false });
    const body = resp.data || {};
    const uuid = body.uuid || '';
    const qrcode = (body.qrcode && (body.qrcode.qrcodeurl || body.qrcode.qrcode_url)) || '';
    const qrBase64 = body.qrcode && body.qrcode.qrcodebase64;

    if (!uuid || !qrcode) {
      throw new Error(`wx login init failed: ${JSON.stringify(body)}`);
    }

    this.state.pendingWxUuid = uuid;
    this.state.pendingWxQrUrl = qrcode;

    let qrFile = '';
    if (qrBase64) {
      qrFile = path.join(path.dirname(this.statePath), `wechat_qr_${uuid}.jpg`);
      fs.writeFileSync(qrFile, Buffer.from(String(qrBase64), 'base64'));
    }

    this.save();

    return { uuid, qrcode, qrFile };
  }

  async wxLoginCheck(uuid) {
    const useUuid = uuid || this.state.pendingWxUuid;
    if (!useUuid) throw new Error('missing uuid, run wx-login-init first');

    const resp = await this.callLocal('/login/wx/check', { uuid: useUuid, timestamp: Date.now() }, { auth: false });
    const body = resp.data || {};
    const status = Number(body.wx_errcode || body.errcode || -1);
    const wxCode = body.wx_code || '';

    return { status, wxCode, raw: body };
  }

  async wxLoginWait(timeoutSec = 180, intervalMs = 2000) {
    const started = Date.now();
    while (Date.now() - started < timeoutSec * 1000) {
      const checked = await this.wxLoginCheck();
      if (checked.status === 405 && checked.wxCode) {
        const loginResp = await this.callLocal('/login/openplat', { code: checked.wxCode }, { auth: true, timeout: 20000 });
        this.mergeBodyLoginData(loginResp.data || {});
        this.state.lastLoginAt = new Date().toISOString();
        await this.registerDev();
        await this.refreshLogin();
        this.save();
        return { ok: true, login: loginResp.data };
      }
      if (checked.status === 402 || checked.status === 403) {
        return { ok: false, reason: checked.raw };
      }
      await sleep(intervalMs);
    }
    return { ok: false, reason: 'timeout' };
  }

  async registerDev() {
    if (!this.state.token || !this.state.userid) {
      throw new Error('not logged in, token/userid missing');
    }
    const resp = await this.callLocal('/register/dev', this.ensureAuthParams(), { auth: true, timeout: 20000 });
    const body = resp.data || {};
    const dfid = body && body.data && body.data.dfid;
    if (dfid) {
      this.state.cookies.dfid = String(dfid);
      this.state.dfid = String(dfid);
      this.save();
    }
    return body;
  }

  async refreshLogin() {
    if (!this.state.token || !this.state.userid) {
      throw new Error('not logged in, token/userid missing');
    }
    const resp = await this.callLocal('/login/token', this.ensureAuthParams(), { auth: true, timeout: 20000 });
    const body = resp.data || {};
    this.mergeBodyLoginData(body);
    this.save();
    return body;
  }

  async loginStatus() {
    if (!this.state.token || !this.state.userid) {
      return { ok: false, reason: 'not_logged_in' };
    }
    const resp = await this.callLocal('/user/detail', this.ensureAuthParams(), { auth: true, timeout: 20000 });
    const body = resp.data || {};
    const ok = Number(body.status) === 1 && !!body.data;
    return { ok, profile: body.data || null, raw: body };
  }

  async claimVip(receiveDay = today(), doUpgrade = true) {
    if (!this.state.token || !this.state.userid) {
      throw new Error('not logged in, token/userid missing');
    }
    const res1 = await this.callLocal('/youth/day/vip', this.ensureAuthParams({ receive_day: receiveDay }), { auth: true, timeout: 20000 });
    let res2 = null;
    if (doUpgrade) {
      const r2 = await this.callLocal('/youth/day/vip/upgrade', this.ensureAuthParams(), { auth: true, timeout: 20000 });
      res2 = r2.data || {};
    }
    return { dayVip: res1.data || {}, upgradeVip: res2 };
  }

  async cloudList(page = 1, pagesize = 30) {
    if (!this.state.token || !this.state.userid) {
      throw new Error('not logged in, token/userid missing');
    }
    const resp = await this.callLocal('/user/cloud', this.ensureAuthParams({ page, pagesize }), { auth: true, timeout: 20000 });
    const body = resp.data || {};
    const data = body.data || {};
    let list = data.list;
    if (typeof list === 'string') {
      try {
        list = JSON.parse(list);
      } catch {
        list = [];
      }
    }
    if (!Array.isArray(list)) list = [];
    return {
      status: body.status,
      error_code: body.error_code,
      list_count: data.list_count || list.length || 0,
      used_size: data.used_size || 0,
      availble_size: data.availble_size || 0,
      list,
      raw: body,
    };
  }

  async cloudUrl(hash, extra = {}) {
    if (!hash) throw new Error('missing hash');
    const resp = await this.callLocal(
      '/user/cloud/url',
      this.ensureAuthParams({
        hash,
        album_id: extra.album_id || 0,
        audio_id: extra.audio_id || 0,
        name: extra.name || '',
      }),
      { auth: true, timeout: 20000 }
    );
    return resp.data || {};
  }

  async cloudDownload(hash, opts = {}) {
    const body = await this.cloudUrl(hash, opts);
    const data = body.data || {};
    const url = data.url || data.file || data.play_url || '';
    if (!url) throw new Error(`cloud url not found: ${JSON.stringify(body).slice(0, 300)}`);

    ensureDir(this.downloadDir);
    const filenameBase = sanitizeName(opts.name || hash);
    const ext = sanitizeName((data.extname || data.ext || 'mp3').toLowerCase());
    const outPath = path.join(this.downloadDir, `${filenameBase}.${ext}`);

    const dl = await axios.get(url, {
      responseType: 'stream',
      timeout: 120000,
      proxy: false,
      validateStatus: () => true,
    });
    if (dl.status < 200 || dl.status >= 300) {
      throw new Error(`cloud download failed status=${dl.status}`);
    }
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(outPath);
      dl.data.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    let uploaded = null;
    if (opts.uploadCmd) {
      const env = Object.assign({}, process.env, {
        FILE_PATH: outPath,
        FILE_NAME: path.basename(outPath),
      });
      const r = spawnSync('bash', ['-lc', opts.uploadCmd], { env, encoding: 'utf8' });
      uploaded = { code: r.status, stdout: r.stdout, stderr: r.stderr };
    }

    let alist = null;
    if (opts.alistUpload) {
      alist = await this.alistUploadFile(outPath, opts.alist || {});
    }

    return { file: outPath, url, uploaded, alist, raw: body };
  }

  async getUserPlaylists(page = 1, pagesize = 30) {
    const resp = await this.callLocal('/user/playlist', this.ensureAuthParams({ page, pagesize }), {
      auth: true,
      timeout: 20000,
    });
    return resp.data || {};
  }

  async getPlaylistTracks(listid, page = 1, pagesize = 50) {
    const resp = await this.callLocal('/playlist/track/all/new', this.ensureAuthParams({ listid, page, pagesize }), {
      auth: true,
      timeout: 20000,
    });
    return resp.data || {};
  }

  trackHashes(track) {
    const out = [];
    const add = (v) => {
      if (!v) return;
      const h = String(v).toUpperCase();
      if (!out.includes(h)) out.push(h);
    };
    add(track.hash);
    add(track.sqhash);
    add(track['320hash']);
    if (track.trans_param) {
      add(track.trans_param.ogg_320_hash);
      add(track.trans_param.ogg_128_hash);
      add(track.trans_param.hash_multitrack);
    }
    return out;
  }

  async syncPlaylistsOnce(opts = {}) {
    if (!this.state.syncedTracks || typeof this.state.syncedTracks !== 'object') {
      this.state.syncedTracks = {};
    }
    await this.refreshLogin();
    if (!this.state.dfid) {
      await this.registerDev();
    }

    const pagesize = Number(opts.pagesize || 30);
    const trackPagesize = Number(opts.trackPagesize || 50);
    const minBitrate = Math.max(0, Number(opts.minBitrate || 0));
    const forceResync = !!opts.forceResync;
    const onlyListIds = (opts.listids || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const profile = await this.loginStatus();
    const nick = profile && profile.profile && profile.profile.nickname ? String(profile.profile.nickname) : 'user';
    const accountDir = sanitizePathSegment(`${this.state.userid}-${nick}`);
    const baseRemoteDir = opts.alist?.remoteDir || '/156天翼云盘/kugou-openalist';
    const manifestRoot = path.join(path.dirname(this.statePath), 'manifests', accountDir);

    const first = await this.getUserPlaylists(1, pagesize);
    const pData = first.data || {};
    const total = Number(pData.list_count || (pData.info || []).length || 0);
    const totalPages = Math.max(1, Math.ceil(total / pagesize));
    let playlists = Array.isArray(pData.info) ? [...pData.info] : [];

    for (let p = 2; p <= totalPages; p++) {
      const next = await this.getUserPlaylists(p, pagesize);
      const info = Array.isArray(next.data?.info) ? next.data.info : [];
      playlists = playlists.concat(info);
    }

    if (onlyListIds.length) {
      playlists = playlists.filter((pl) => onlyListIds.includes(String(pl.listid)));
    }

    const stats = {
      playlists: playlists.length,
      scannedTracks: 0,
      newTracks: 0,
      skipped: 0,
      skippedLowBitrate: 0,
      uploaded: 0,
      failed: 0,
      items: [],
    };

    for (const pl of playlists) {
      const listid = pl.listid;
      const playlistName = sanitizePathSegment(pl.name || `playlist_${listid}`);
      const firstTracks = await this.getPlaylistTracks(listid, 1, trackPagesize);
      const tData = firstTracks.data || {};
      const count = Number(tData.count || 0);
      const pages = Math.max(1, Math.ceil(count / trackPagesize));
      let tracks = Array.isArray(tData.info) ? [...tData.info] : [];
      for (let p = 2; p <= pages; p++) {
        const next = await this.getPlaylistTracks(listid, p, trackPagesize);
        const info = Array.isArray(next.data?.info) ? next.data.info : [];
        tracks = tracks.concat(info);
      }

      for (const track of tracks) {
        stats.scannedTracks += 1;
        const baseHash = String(track.hash || '').toUpperCase();
        if (!baseHash) {
          stats.skipped += 1;
          continue;
        }

        const key = `${listid}:${baseHash}`;
        if (!forceResync && this.state.syncedTracks[key]) {
          stats.skipped += 1;
          continue;
        }

        stats.newTracks += 1;
        try {
          const hashes = this.trackHashes(track);
          const best = await this.resolveBestUrlByHashes(hashes, {
            album_audio_id: track.mixsongid || track.audio_id || 0,
          });
          if (!best) {
            throw new Error('no playable url');
          }
          if (best.bitrate < minBitrate) {
            stats.skippedLowBitrate += 1;
            stats.items.push({
              listid,
              playlist: pl.name,
              hash: baseHash,
              bitrate: best.bitrate,
              skip: `bitrate<${minBitrate}`,
            });
            continue;
          }

          ensureDir(this.downloadDir);
          const singer = sanitizeName((track.singerinfo || []).map((x) => x.name).filter(Boolean).join('&') || track.singername || 'unknown');
          const song = sanitizeName((track.name || '').replace(/\.(mp3|flac|wav)$/i, '') || track.songname || baseHash);
          const ext = sanitizeName(best.ext || 'bin');
          const fileName = `${singer} - ${song} [${best.bitrate}k].${ext}`;
          const localPath = path.join(this.downloadDir, fileName);

          const dl = await axios.get(best.url, {
            responseType: 'stream',
            timeout: 120000,
            proxy: false,
            validateStatus: () => true,
          });
          if (dl.status < 200 || dl.status >= 300) {
            throw new Error(`download failed status=${dl.status}`);
          }
          await new Promise((resolve, reject) => {
            const ws = fs.createWriteStream(localPath);
            dl.data.pipe(ws);
            ws.on('finish', resolve);
            ws.on('error', reject);
          });

          const alist = await this.alistUploadFile(localPath, {
            baseUrl: opts.alist?.baseUrl,
            username: opts.alist?.username,
            password: opts.alist?.password,
            remoteDir: `${baseRemoteDir}/${accountDir}/${playlistName}`,
          });

          this.state.syncedTracks[key] = {
            listid,
            playlist: pl.name || '',
            hash: baseHash,
            song: track.name || '',
            file: localPath,
            remotePath: alist.remotePath,
            syncedAt: new Date().toISOString(),
          };
          this.save();
          await this.updateManifestsRealtime({
            accountDir,
            playlistName,
            listid,
            baseRemoteDir,
            manifestRoot,
            alist: opts.alist || {},
          });
          stats.uploaded += 1;
          stats.items.push({ listid, playlist: pl.name, hash: baseHash, file: localPath, remotePath: alist.remotePath });
        } catch (err) {
          stats.failed += 1;
          stats.items.push({ listid, playlist: pl.name, hash: baseHash, error: err.message || String(err) });
        }
      }
    }
    return stats;
  }

  async syncPlaylistsLoop(opts = {}) {
    const intervalSec = Math.max(10, Number(opts.interval || 180));
    const maxRounds = opts.maxRounds ? Number(opts.maxRounds) : 0;
    const rounds = [];
    let round = 0;
    while (true) {
      round += 1;
      const result = await this.syncPlaylistsOnce(opts);
      rounds.push({ round, at: new Date().toISOString(), result });
      if (maxRounds > 0 && round >= maxRounds) break;
      await sleep(intervalSec * 1000);
    }
    return { rounds };
  }

  async searchPublic(keyword, page = 1, pagesize = 10) {
    const resp = await axios.get('http://mobilecdn.kugou.com/api/v3/search/song', {
      params: {
        format: 'json',
        keyword,
        page,
        pagesize,
        showtype: 1,
      },
      timeout: 15000,
      proxy: false,
      validateStatus: () => true,
    });
    const body = resp.data || {};
    const list = (((body || {}).data || {}).info || []).map((item) => {
      const groups = Array.isArray(item.group) ? item.group : [];
      const hashes = [];
      const addHash = (h) => {
        if (h && !hashes.includes(h)) hashes.push(h);
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
        songname: item.songname,
        singername: item.singername,
        album_name: item.album_name,
        duration: item.duration,
        filename: item.filename,
        hashes,
        raw: item,
      };
    });

    return { raw: body, list };
  }

  pickBestBySinger(list, singer) {
    if (!singer) return list[0] || null;
    const s = singer.toLowerCase();
    const exact = list.find((x) => String(x.singername || '').toLowerCase().includes(s));
    return exact || list[0] || null;
  }

  scoreSearchItem(item, opts = {}) {
    const song = normalizeText(item.songname);
    const singer = normalizeText(item.singername);
    const album = normalizeText(item.album_name);
    const filename = normalizeText(item.filename);
    const kw = normalizeText(opts.keyword || '');
    const sg = normalizeText(opts.singer || '');
    const ab = normalizeText(opts.album || '');
    let score = 0;

    if (kw) {
      if (song === kw) score += 60;
      else if (song.includes(kw) || kw.includes(song)) score += 35;
      if (filename.includes(kw)) score += 20;
      if (album.includes(kw)) score += 10;
    }
    if (sg) {
      if (singer === sg) score += 50;
      else if (singer.includes(sg) || sg.includes(singer)) score += 30;
    }
    if (ab) {
      if (album === ab) score += 40;
      else if (album.includes(ab) || ab.includes(album)) score += 20;
    }
    return score;
  }

  async resolveBestUrlByHashes(hashes, extraQuery = {}) {
    const qualities = ['viper_clear', 'viper_atmos', 'viper_tape', 'flac', 'sq', 'high', '320', '128'];
    let best = null;
    const visited = new Set();
    const queue = [];
    const enqueueHash = (h) => {
      const v = String(h || '').trim().toUpperCase();
      if (!v || visited.has(v)) return;
      queue.push(v);
    };
    for (const h of hashes || []) enqueueHash(h);

    const normalizeCandidate = (h, q, payload) => {
      if (!payload || typeof payload !== 'object') return null;
      const info = payload.info && typeof payload.info === 'object' ? payload.info : payload;
      const url = (Array.isArray(info.tracker_url) && info.tracker_url[0]) || (Array.isArray(info.en_tracker_url) && info.en_tracker_url[0]) || info.url || '';
      if (!url) return null;
      let bitrate = Number(info.bitrate || info.bitRate || payload.bitrate || payload.bitRate || 0);
      const filesize = Number(info.filesize || info.fileSize || 0);
      const ext = info.extname || info.extName || info.en_extname || inferExtFromUrl(url) || 'bin';
      const hasPlainTracker = !!(Array.isArray(info.tracker_url) && info.tracker_url[0]);
      const isEncryptedMgg = /\.mgg(?:\?|$)/i.test(String(url)) || String(ext).toLowerCase() === 'mgg';
      if (!bitrate) {
        const qmap = { flac: 999, viper_clear: 999, viper_atmos: 999, sq: 999, viper_tape: 320, high: 320, '320': 320, '128': 128 };
        bitrate = Number(qmap[String(payload.quality || q || '').toLowerCase()] || 0);
      }
      return { hash: h, reqQuality: q, bitrate, filesize, ext, url, hasPlainTracker, isEncryptedMgg, raw: payload };
    };

    const candidatesFromBody = (h, q, body) => {
      const out = [];
      if (!body || typeof body !== 'object') return out;
      const add = (item) => {
        const c = normalizeCandidate(h, q, item);
        if (c) out.push(c);
        const tr = item && item.trans_param && typeof item.trans_param === 'object' ? item.trans_param : {};
        enqueueHash(item && item.hash);
        enqueueHash(tr.ogg_320_hash);
        enqueueHash(tr.ogg_128_hash);
        enqueueHash(tr.hash_multitrack);
      };

      // /song/url style
      if (body.data && !Array.isArray(body.data)) {
        add(body.data);
      }
      if (body.info && typeof body.info === 'object') {
        add(body.info);
      }

      // /song/url/new style
      const arr = Array.isArray(body.data) ? body.data : [];
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        add(item);
        const rg = Array.isArray(item.relate_goods) ? item.relate_goods : [];
        for (const g of rg) add(g);
      }
      return out;
    };

    const pickBest = (current) => {
      if (!current) return;
      if (
        !best ||
        current.bitrate > best.bitrate ||
        (current.bitrate === best.bitrate && current.filesize > best.filesize) ||
        (current.bitrate === best.bitrate &&
          current.filesize === best.filesize &&
          Number(current.isEncryptedMgg) < Number(best.isEncryptedMgg)) ||
        (current.bitrate === best.bitrate &&
          current.filesize === best.filesize &&
          current.isEncryptedMgg === best.isEncryptedMgg &&
          Number(current.hasPlainTracker) > Number(best.hasPlainTracker))
      ) {
        best = current;
      }
    };

    // Explore initial hash set + derived hashes returned by trans_param.
    while (queue.length) {
      const h = queue.shift();
      if (!h) continue;
      if (visited.has(h)) continue;
      visited.add(h);
      for (const q of qualities) {
        // Preferred path: /song/url + quality
        const respClassic = await this.callLocal('/song/url', this.ensureAuthParams(Object.assign({ hash: h, quality: q }, extraQuery)), {
          auth: true,
          timeout: 20000,
        });
        const bodyClassic = respClassic.data || {};
        if (Number(bodyClassic.status) === 1 || Number(bodyClassic.err_code) === 0 || Number(bodyClassic.error_code) === 0) {
          for (const c of candidatesFromBody(h, q, bodyClassic)) {
            pickBest(c);
          }
        }

        // Fallback path: /song/url/new + quality
        if (!best || best.bitrate < 320) {
          const respNew = await this.callLocal('/song/url/new', this.ensureAuthParams(Object.assign({ hash: h, quality: q }, extraQuery)), {
            auth: true,
            timeout: 20000,
          });
          const bodyNew = respNew.data || {};
          if (Number(bodyNew.status) === 1 || Number(bodyNew.error_code) === 0 || Array.isArray(bodyNew.data)) {
            for (const c of candidatesFromBody(h, q, bodyNew)) {
              pickBest(c);
            }
          }
        }
      }
    }

    return best;
  }

  async downloadByKeyword(keyword, opts = {}) {
    if (!this.state.token || !this.state.userid) {
      throw new Error('not logged in, token/userid missing');
    }

    const page = Number(opts.page || 1);
    const pagesize = Number(opts.pagesize || 10);
    const scanPages = Math.max(1, Number(opts.scanPages || 1));
    const maxCandidates = Math.max(1, Number(opts.maxCandidates || 8));
    const index = Math.max(1, Number(opts.index || 1));

    const all = [];
    for (let p = page; p < page + scanPages; p++) {
      const searched = await this.searchPublic(keyword, p, pagesize);
      all.push(...searched.list);
    }
    if (!all.length) throw new Error('no search result');

    const ranked = all
      .map((item) => ({ item, score: this.scoreSearchItem(item, { keyword, singer: opts.singer || '', album: opts.album || '' }) }))
      .sort((a, b) => b.score - a.score);

    let pool = ranked;
    if (opts.singer) {
      const sg = normalizeText(opts.singer);
      const matchedSinger = ranked.filter((x) => normalizeText(x.item.singername).includes(sg));
      if (matchedSinger.length) pool = matchedSinger;
    }
    if (opts.album) {
      const ab = normalizeText(opts.album);
      const matchedAlbum = pool.filter((x) => normalizeText(x.item.album_name).includes(ab));
      if (matchedAlbum.length) pool = matchedAlbum;
    }

    const selectedPool = [];
    const seen = new Set();
    for (const x of pool) {
      const k = `${x.item.singername}|${x.item.songname}|${x.item.album_name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      selectedPool.push(x);
      if (selectedPool.length >= maxCandidates) break;
    }
    if (!selectedPool.length) throw new Error('no candidate after ranking');

    // Keep index semantics for manual pinning.
    if (scanPages === 1 && !opts.singer && !opts.album && index > 1 && ranked[index - 1]) {
      selectedPool.unshift(ranked[index - 1]);
    }

    let selected = null;
    let best = null;
    for (const x of selectedPool) {
      const item = x.item;
      if (!item || !Array.isArray(item.hashes) || !item.hashes.length) continue;
      const cur = await this.resolveBestUrlByHashes(item.hashes);
      if (!cur) continue;
      if (!best || cur.bitrate > best.bitrate || (cur.bitrate === best.bitrate && cur.filesize > best.filesize)) {
        best = cur;
        selected = item;
      }
    }
    if (!selected || !best) throw new Error('no playable url resolved');

    ensureDir(this.downloadDir);

    const safeSinger = sanitizeName(selected.singername || 'unknown');
    const safeSong = sanitizeName(selected.songname || keyword);
    const ext = sanitizeName(best.ext || 'bin');
    const filename = `${safeSinger} - ${safeSong} [${best.bitrate}k].${ext}`;
    const outPath = path.join(this.downloadDir, filename);

    const dl = await axios.get(best.url, {
      responseType: 'stream',
      timeout: 120000,
      proxy: false,
      validateStatus: () => true,
    });

    if (dl.status < 200 || dl.status >= 300) {
      throw new Error(`download failed status=${dl.status}`);
    }

    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(outPath);
      dl.data.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
    });

    let uploaded = null;
    if (opts.uploadCmd) {
      const env = Object.assign({}, process.env, {
        FILE_PATH: outPath,
        FILE_NAME: filename,
      });
      const r = spawnSync('bash', ['-lc', opts.uploadCmd], { env, encoding: 'utf8' });
      uploaded = {
        code: r.status,
        stdout: r.stdout,
        stderr: r.stderr,
      };
    }

    let alist = null;
    if (opts.alistUpload) {
      alist = await this.alistUploadFile(outPath, opts.alist || {});
    }

    return {
      selected: {
        songname: selected.songname,
        singername: selected.singername,
        album_name: selected.album_name,
      },
      best,
      file: outPath,
      uploaded,
      alist,
    };
  }

  async alistLogin(cfg) {
    const username = cfg.username || '';
    const password = cfg.password || '';
    if (!username || !password) {
      throw new Error('alist username/password missing');
    }
    const resp = await axios.post(
      `${cfg.baseUrl}/api/auth/login`,
      { username, password },
      { timeout: 15000, proxy: false, validateStatus: () => true }
    );
    const body = resp.data || {};
    if (resp.status < 200 || resp.status >= 300 || Number(body.code) !== 200 || !body.data?.token) {
      throw new Error(`alist login failed: ${JSON.stringify(body).slice(0, 300)}`);
    }
    return body.data.token;
  }

  async alistUploadFile(localPath, cfg = {}) {
    const baseUrl = cfg.baseUrl || process.env.ALIST_URL || 'http://127.0.0.1:5244';
    const username = cfg.username || process.env.ALIST_USER || '';
    const password = cfg.password || process.env.ALIST_PASS || '';
    const remoteDir = cfg.remoteDir || process.env.ALIST_DIR || '/156天翼云盘/kugou-openalist';
    const asTask = cfg.asTask === undefined ? true : !!cfg.asTask;

    const token = await this.alistLogin({ baseUrl, username, password });
    const fileName = path.basename(localPath);
    const remotePath = `${String(remoteDir).replace(/\/+$/, '')}/${fileName}`;
    const encodedPath = encodeAlistPath(remotePath);
    const stat = fs.statSync(localPath);

    const stream = fs.createReadStream(localPath);
    const resp = await axios.put(`${baseUrl}/api/fs/put`, stream, {
      headers: {
        Authorization: token,
        'File-Path': encodedPath,
        'As-Task': asTask ? 'true' : 'false',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stat.size),
        Connection: 'close',
      },
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      proxy: false,
      validateStatus: () => true,
    });
    const body = resp.data || {};
    if (resp.status < 200 || resp.status >= 300 || Number(body.code) !== 200) {
      throw new Error(`alist upload failed: ${JSON.stringify(body).slice(0, 300)}`);
    }

    return { ok: true, remotePath, message: body.message || '' };
  }

  playlistEntries(listid) {
    return Object.values(this.state.syncedTracks || {}).filter((x) => String(x.listid) === String(listid));
  }

  accountEntries() {
    return Object.values(this.state.syncedTracks || {});
  }

  async writeAndUploadManifest(localFile, remoteDir, content, alist) {
    ensureDir(path.dirname(localFile));
    fs.writeFileSync(localFile, content);
    await this.alistUploadFile(localFile, {
      baseUrl: alist.baseUrl,
      username: alist.username,
      password: alist.password,
      remoteDir,
    });
  }

  async updateManifestsRealtime(opts) {
    const { accountDir, playlistName, listid, baseRemoteDir, manifestRoot, alist } = opts;
    const pDirLocal = path.join(manifestRoot, sanitizePathSegment(playlistName));
    const pDirRemote = `${baseRemoteDir}/${accountDir}/${sanitizePathSegment(playlistName)}`;
    const pEntries = this.playlistEntries(listid);

    const pJsonl = pEntries.map((x) => JSON.stringify(x)).join('\n') + (pEntries.length ? '\n' : '');
    const pMd =
      `# ${playlistName}\n\n` +
      `- Track Count: ${pEntries.length}\n` +
      `- Updated At: ${new Date().toISOString()}\n\n` +
      `| Song | Hash | Remote Path | Synced At |\n|---|---|---|---|\n` +
      pEntries
        .map(
          (e) =>
            `| ${String(e.song || '').replace(/\|/g, '\\|')} | ${e.hash || ''} | ${String(e.remotePath || '').replace(/\|/g, '\\|')} | ${e.syncedAt || ''} |`
        )
        .join('\n') +
      '\n';

    await this.writeAndUploadManifest(path.join(pDirLocal, 'tracks.jsonl'), pDirRemote, pJsonl, alist);
    await this.writeAndUploadManifest(path.join(pDirLocal, 'README.md'), pDirRemote, pMd, alist);

    const aDirLocal = manifestRoot;
    const aDirRemote = `${baseRemoteDir}/${accountDir}`;
    const aEntries = this.accountEntries();
    const aJsonl = aEntries.map((x) => JSON.stringify(x)).join('\n') + (aEntries.length ? '\n' : '');
    const aMd =
      `# Kugou Library Index\n\n` +
      `- Track Count: ${aEntries.length}\n` +
      `- Updated At: ${new Date().toISOString()}\n\n` +
      `| Playlist | Song | Hash | Remote Path | Synced At |\n|---|---|---|---|---|\n` +
      aEntries
        .map(
          (e) =>
            `| ${String(e.playlist || '').replace(/\|/g, '\\|')} | ${String(e.song || '').replace(/\|/g, '\\|')} | ${e.hash || ''} | ${String(e.remotePath || '').replace(/\|/g, '\\|')} | ${e.syncedAt || ''} |`
        )
        .join('\n') +
      '\n';

    await this.writeAndUploadManifest(path.join(aDirLocal, 'library.jsonl'), aDirRemote, aJsonl, alist);
    await this.writeAndUploadManifest(path.join(aDirLocal, 'LIBRARY.md'), aDirRemote, aMd, alist);
  }
}

function printUsage() {
  console.log(`Usage:
  node scripts/kugou_assistant.js <command> [options]

Commands:
  wx-login-init
  wx-login-check [--uuid <uuid>]
  wx-login-wait [--timeout <sec>] [--interval <ms>]
  status
  refresh
  claim-vip [--day YYYY-MM-DD] [--no-upgrade]
  cloud-list [--page 1] [--pagesize 30]
  cloud-download --hash <hash> [--name <name>] [--upload-cmd '...'] [--alist-upload]
  sync-playlists [--listids 2,3] [--interval 180] [--max-rounds 0]
  search --keyword <kw> [--page 1] [--pagesize 10]
  download --keyword <kw> [--singer <name>] [--index 1] [--upload-cmd '...'] [--alist-upload]
  register-dev

Global options:
  --base-url <url>       default http://127.0.0.1:5301
  --state <file>         default ./.kugou/session.json
  --download-dir <dir>   default ./.kugou/downloads
  --alist-url <url>      default http://127.0.0.1:5244
  --alist-user <user>    default from ALIST_USER
  --alist-pass <pass>    default from ALIST_PASS
  --alist-dir <dir>      default /156天翼云盘/kugou-openalist
  --min-bitrate <n>      for sync-playlists only, skip tracks below bitrate n
  --force-resync         for sync-playlists only, ignore local synced cache
  --scan-pages <n>       for download only, search across n pages before selecting best quality
  --max-candidates <n>   for download only, compare top n matched candidates
`);
}

(async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    if (!cmd) {
      printUsage();
      process.exit(1);
    }

    const statePath = path.resolve(process.cwd(), args.state || './.kugou/session.json');
    const downloadDir = path.resolve(process.cwd(), args['download-dir'] || './.kugou/downloads');
    const assistant = new KugouAssistant({
      baseUrl: args['base-url'],
      statePath,
      downloadDir,
    });

    let out = null;
    switch (cmd) {
      case 'wx-login-init':
        out = await assistant.wxLoginInit();
        break;
      case 'wx-login-check':
        out = await assistant.wxLoginCheck(args.uuid);
        break;
      case 'wx-login-wait':
        out = await assistant.wxLoginWait(Number(args.timeout || 180), Number(args.interval || 2000));
        break;
      case 'status':
        out = await assistant.loginStatus();
        break;
      case 'refresh':
        out = await assistant.refreshLogin();
        break;
      case 'register-dev':
        out = await assistant.registerDev();
        break;
      case 'claim-vip':
        out = await assistant.claimVip(args.day || today(), !args['no-upgrade']);
        break;
      case 'cloud-list':
        out = await assistant.cloudList(Number(args.page || 1), Number(args.pagesize || 30));
        break;
      case 'cloud-download':
        if (!args.hash) throw new Error('missing --hash');
        out = await assistant.cloudDownload(args.hash, {
          name: args.name || '',
          album_id: args['album-id'] || 0,
          audio_id: args['audio-id'] || 0,
          uploadCmd: args['upload-cmd'] || '',
          alistUpload: !!args['alist-upload'],
          alist: {
            baseUrl: args['alist-url'],
            username: args['alist-user'],
            password: args['alist-pass'],
            remoteDir: args['alist-dir'],
          },
        });
        break;
      case 'search':
        if (!args.keyword) throw new Error('missing --keyword');
        out = await assistant.searchPublic(args.keyword, Number(args.page || 1), Number(args.pagesize || 10));
        out = out.list;
        break;
      case 'sync-playlists':
        out = await assistant.syncPlaylistsLoop({
          listids: args.listids || '',
          interval: Number(args.interval || 180),
          maxRounds: Number(args['max-rounds'] || 0),
          pagesize: Number(args.pagesize || 30),
          trackPagesize: Number(args['track-pagesize'] || 50),
          minBitrate: Number(args['min-bitrate'] || 0),
          forceResync: !!args['force-resync'],
          alist: {
            baseUrl: args['alist-url'],
            username: args['alist-user'],
            password: args['alist-pass'],
            remoteDir: args['alist-dir'],
          },
        });
        break;
      case 'download':
        if (!args.keyword) throw new Error('missing --keyword');
        out = await assistant.downloadByKeyword(args.keyword, {
          singer: args.singer,
          album: args.album,
          index: args.index,
          page: args.page,
          pagesize: args.pagesize,
          scanPages: args['scan-pages'],
          maxCandidates: args['max-candidates'],
          uploadCmd: args['upload-cmd'] || '',
          alistUpload: !!args['alist-upload'],
          alist: {
            baseUrl: args['alist-url'],
            username: args['alist-user'],
            password: args['alist-pass'],
            remoteDir: args['alist-dir'],
          },
        });
        break;
      default:
        printUsage();
        process.exit(1);
    }

    assistant.save();
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    console.error('[ERROR]', err && err.message ? err.message : err);
    process.exit(2);
  }
})();
