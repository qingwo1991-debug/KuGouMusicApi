/**
 * 智能推荐引擎 v2 - 带记忆学习系统
 *
 * 架构：
 * play_history (原始播放日志) → memory_vectors (学习后的偏好记忆) → recommend (推荐评分)
 *
 * 记忆机制：
 * - 每次播放更新记忆向量（实时学习）
 * - 不同维度有不同衰减率（歌手慢衰、时段快衰）
 * - 收藏歌曲给记忆大幅加成
 * - 播放时长决定学习强度（完整听=强信号，跳过=弱信号）
 */

const mysql = require('mysql2/promise');

const DB = {
  host: process.env.MYSQL_HOST || 'alist_mysql',
  port: parseInt(process.env.MYSQL_PORT || '3306'),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.KUGOU_DB_PASS || '',
  database: 'kugou_music',
  waitForConnections: true,
  connectionLimit: 5,
};

// ===== 边界控制配置 =====
const BOUNDARIES = {
  // 记忆分数上下限
  SCORE_MIN: 0,
  SCORE_MAX: 100,
  // 删除记忆的阈值
  SCORE_DELETE: 0.5,
  // 播放日志最大保留条数
  HISTORY_MAX: 10000,
  // 记忆向量最大条数（防暴涨）
  MEMORY_MAX: 500,
  // 收藏最大条数
  FAVORITE_MAX: 5000,
  // 单次更新最大记忆向量数
  MEMORY_UPDATE_MAX: 10,
  // 衰减清理周期（毫秒）6小时
  DECAY_INTERVAL: 6 * 60 * 60 * 1000,
  // 播放去重间隔（同一首歌短时间内多次播放只记一次，毫秒）30秒
  PLAY_DEDUPE_MS: 30 * 1000,
  // 数据库查询超时（毫秒）
  QUERY_TIMEOUT: 10000,
};

// ===== 热度阈值 =====
const HEAT_FLAME = 500000;
const HEAT_FIRE = 1000000;
const HEAT_BLAST = 3000000;

// ===== 衰减率配置（基于播放次数，而非自然时间） =====
const DECAY = {
  singer:     { rate: 0.02,  label: '歌手偏好' },     // 每听35首不同的歌衰减一半
  language:   { rate: 0.015, label: '语种偏好' },     // 每听46首不同的歌衰减一半
  decade:     { rate: 0.018, label: '年代偏好' },     // 每听38首
  album_type: { rate: 0.025, label: '专辑类型偏好' },  // 每听27首
  hour:       { rate: 0.04,  label: '时段偏好' },     // 每听17首
  weekday:    { rate: 0.03,  label: '星期偏好' },     // 每听23首
  fav_singer: { rate: 0.005, label: '收藏歌手偏好' },  // 每听138首（几乎不衰减）
};

let pool = null;
function getPool() { if (!pool) pool = mysql.createPool(DB); return pool; }

// 确保某 userid 的画像行存在（幂等）
async function ensureProfile(userid) {
  try {
    await getPool().query(`INSERT IGNORE INTO user_profile (userid) VALUES (?)`, [userid || '']);
  } catch (e) { /* ignore */ }
}

// ===== 输入校验 =====
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function sanitizeInput(str, maxLen = 255) {
  if (typeof str !== 'string') return '';
  return str.slice(0, maxLen).replace(/[\x00-\x1f\x7f]/g, '').trim();
}
function validateHash(hash) {
  if (typeof hash !== 'string' || hash.length < 16 || hash.length > 64) return false;
  return /^[a-fA-F0-9]+$/.test(hash);
}

// 播放去重缓存（内存）
const recentPlays = new Map();

// ===== 数据库初始化 =====

async function initDB() {
  try {
    // 先创建数据库
    const tempPool = mysql.createPool({
      ...DB,
      database: undefined,
    });
    await tempPool.query(`CREATE DATABASE IF NOT EXISTS ${DB.database} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await tempPool.end();

    const conn = await getPool().getConnection();

    await conn.query(`CREATE TABLE IF NOT EXISTS play_history (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      hash VARCHAR(64) NOT NULL,
      songname VARCHAR(255) DEFAULT '',
      singername VARCHAR(255) DEFAULT '',
      album_name VARCHAR(255) DEFAULT '',
      duration INT DEFAULT 0,
      play_duration INT DEFAULT 0,
      play_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      hour TINYINT,
      weekday TINYINT,
      language VARCHAR(32) DEFAULT '',
      is_new TINYINT DEFAULT 0,
      publish_date VARCHAR(20) DEFAULT '',
      album_type VARCHAR(64) DEFAULT '',
      heat BIGINT DEFAULT 0,
      is_original TINYINT DEFAULT 1,
      pay_type TINYINT DEFAULT 0,
      cid INT DEFAULT 0,
      mixsongid INT DEFAULT 0,
      topic_url VARCHAR(500) DEFAULT '',
      INDEX idx_hash (hash),
      INDEX idx_singer (singername),
      INDEX idx_play_time (play_time),
      INDEX idx_language (language),
      INDEX idx_heat (heat)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS favorites (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      hash VARCHAR(64) NOT NULL UNIQUE,
      songname VARCHAR(255) DEFAULT '',
      singername VARCHAR(255) DEFAULT '',
      album_name VARCHAR(255) DEFAULT '',
      duration INT DEFAULT 0,
      favorited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      language VARCHAR(32) DEFAULT '',
      publish_date VARCHAR(20) DEFAULT '',
      heat BIGINT DEFAULT 0,
      is_new TINYINT DEFAULT 0,
      mixsongid INT DEFAULT 0,
      INDEX idx_hash (hash),
      INDEX idx_singer (singername),
      INDEX idx_heat (heat)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await conn.query(`CREATE TABLE IF NOT EXISTS user_profile (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      userid VARCHAR(32) NOT NULL DEFAULT '',
      total_plays INT DEFAULT 0,
      total_listen INT DEFAULT 0,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_userid (userid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // ===== 记忆向量表（核心） =====
    await conn.query(`CREATE TABLE IF NOT EXISTS memory_vectors (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      vector_type VARCHAR(32) NOT NULL,
      vector_key VARCHAR(255) NOT NULL,
      score FLOAT NOT NULL DEFAULT 0,
      play_count INT DEFAULT 0,
      play_count_at INT DEFAULT 0,
      total_listen INT DEFAULT 0,
      last_played DATETIME DEFAULT NULL,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_type_key (vector_type, vector_key),
      INDEX idx_type_score (vector_type, score DESC),
      INDEX idx_last_played (last_played)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // ===== 为已存在的旧表补齐新列（幂等）=====
    for (const { table, cols } of [
      {
        table: 'play_history',
        cols: [
          // 酷狗播放接口必须带 album_audio_id(mixsongid)，历史歌单需要这个字段才能播放
          { name: 'mixsongid', sql: "ALTER TABLE play_history ADD COLUMN mixsongid INT DEFAULT 0 AFTER cid" },
          { name: 'userid', sql: "ALTER TABLE play_history ADD COLUMN userid VARCHAR(32) NOT NULL DEFAULT '' AFTER id" },
        ],
      },
      {
        table: 'favorites',
        cols: [
          { name: 'mixsongid', sql: "ALTER TABLE favorites ADD COLUMN mixsongid INT DEFAULT 0 AFTER is_new" },
          { name: 'userid', sql: "ALTER TABLE favorites ADD COLUMN userid VARCHAR(32) NOT NULL DEFAULT '' AFTER id" },
        ],
      },
      {
        table: 'memory_vectors',
        cols: [
          { name: 'userid', sql: "ALTER TABLE memory_vectors ADD COLUMN userid VARCHAR(32) NOT NULL DEFAULT '' AFTER id" },
        ],
      },
      {
        table: 'user_profile',
        cols: [
          { name: 'userid', sql: "ALTER TABLE user_profile ADD COLUMN userid VARCHAR(32) NOT NULL DEFAULT '' AFTER id" },
        ],
      },
    ]) {
      for (const c of cols) {
        const [[{ cnt }]] = await conn.query(
          `SELECT COUNT(*) AS cnt FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
          [table, c.name]
        );
        if (cnt === 0) {
          await conn.query(c.sql);
          console.log(`[recommend] Added missing column ${table}.${c.name}`);
        }
      }
    }

    // user_profile 旧表迁移：id 改自增 + userid 唯一索引（幂等，失败忽略）
    try {
      await conn.query(`ALTER TABLE user_profile MODIFY id BIGINT AUTO_INCREMENT`);
    } catch (e) { /* already auto_increment */ }
    try {
      await conn.query(`ALTER TABLE user_profile ADD UNIQUE KEY uk_userid (userid)`);
    } catch (e) { /* already exists */ }

    conn.release();
    console.log('[recommend] Memory system initialized');
  } catch (e) {
    console.error('[recommend] DB init error:', e.message);
  }
}

initDB();

// ===== 记忆更新（核心学习逻辑 - 动态加减分） =====

/**
 * 基于播放次数的衰减（非自然时间）
 * 核心思想：
 *   - 如果一个记忆对应的歌手/语种在最近的播放中没出现，才衰减
 *   - 用户关了几天再打开 → 记忆完好，不受影响
 *   - 打开后连续听了 N 首其他歌 → 记忆才开始衰减
 *
 * new_score = old_score * e^(-λ * plays_since_last)
 *
 * plays_since_last = 总播放次数 - 该记忆最后一次被触发时的总播放次数
 */
async function decayScore(score, decayRate, type, key, totalPlays) {
  if (score <= 0) return 0;
  try {
    const pool = getPool();
    // 获取该记忆最后一次更新时的总播放次数
    const [rows] = await pool.query(
      `SELECT play_count_at FROM memory_vectors WHERE vector_type = ? AND vector_key = ?`,
      [type, key]
    );
    if (rows.length === 0) return 0;

    const playCountAt = rows[0].play_count_at || 0;
    const playsSince = Math.max(0, totalPlays - playCountAt);

    // 基于间隔的播放次数衰减
    return Math.max(0, score * Math.exp(-decayRate * playsSince));
  } catch (e) {
    console.error('[decayScore]', e.message);
    return score;
  }
}

/**
 * 动态加减分系统
 * 
 * 行为              得分
 * ─────────────────────────────────────────
 * 完整听完(≥80%)      +5   强正面信号
 * 听了大半(50-80%)    +3   正面信号
 * 听了一会儿(20-50%)  +1   微弱正面
 * 快速跳过(<20%)      -2   负面信号
 * 秒切(≤5秒)          -3   强负面信号
 * 单曲循环            +3   额外加分
 * 手动点下一首         -1   轻微负面
 * 收藏歌曲            +8   强正面
 * 下载歌曲             +4   正面
 * 调大音量             +1   喜欢信号
 */
async function updateMemory(type, key, playDuration, songDuration, extra = {}) {
  try {
    const pool = getPool();
    const config = DECAY[type] || DECAY.singer;
    const listenRatio = songDuration > 0 ? Math.min(playDuration / songDuration, 1) : 0;

    // 基础得分（根据播放时长）
    let scoreDelta = 0;
    let signalType = 'neutral';
    if (listenRatio >= 0.8) {
      scoreDelta = 5;
      signalType = 'strong_positive';
    } else if (listenRatio >= 0.5) {
      scoreDelta = 3;
      signalType = 'positive';
    } else if (listenRatio >= 0.2) {
      scoreDelta = 1;
      signalType = 'weak_positive';
    } else if (listenRatio >= 0.05) {
      scoreDelta = -2;
      signalType = 'skip';
    } else {
      scoreDelta = -3;
      signalType = 'instant_skip';
    }

    // 额外行为加成/扣分
    if (extra.is_repeat) scoreDelta += 3;          // 单曲循环
    if (extra.is_manual_next) scoreDelta -= 1;     // 手动点下一首
    if (extra.is_favorited) scoreDelta += 8;       // 收藏了这首歌
    if (extra.is_downloaded) scoreDelta += 4;      // 下载了
    if (extra.volume_boost) scoreDelta += 1;       // 调大音量

    // 获取当前记忆
    const [rows] = await pool.query(
      `SELECT score, play_count, play_count_at, total_listen, last_played
       FROM memory_vectors WHERE vector_type = ? AND vector_key = ?`,
      [type, key]
    );

    // 获取当前总播放次数
    const [[{ total_plays: totalPlays }]] = await pool.query(
      `SELECT total_plays FROM user_profile WHERE id = 1`
    );

    let newScore;
    if (rows.length > 0) {
      const old = rows[0];
      // 基于播放次数的衰减（非自然时间）
      const decayed = await decayScore(old.score, config.rate, type, key, totalPlays || 0);
      // 再加减分
      newScore = clamp(decayed + scoreDelta, BOUNDARIES.SCORE_MIN, BOUNDARIES.SCORE_MAX);
    } else {
      // 新记忆，从 0 开始加减
      newScore = clamp(scoreDelta, BOUNDARIES.SCORE_MIN, BOUNDARIES.SCORE_MAX);
    }

    // 如果分数低于阈值，删除记忆（遗忘）
    if (newScore < BOUNDARIES.SCORE_DELETE) {
      await pool.query(
        `DELETE FROM memory_vectors WHERE vector_type = ? AND vector_key = ?`,
        [type, key]
      );
      return { type, key, score: 0, signal: 'forgotten' };
    }

    // 更新记忆（记录当前总播放次数）
    await pool.query(
      `INSERT INTO memory_vectors
       (vector_type, vector_key, score, play_count, play_count_at, total_listen, last_played)
       VALUES (?, ?, ?, 1, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         score = VALUES(score),
         play_count = play_count + 1,
         play_count_at = VALUES(play_count_at),
         total_listen = total_listen + VALUES(total_listen),
         last_played = NOW()`,
      [type, key, newScore, totalPlays || 0, playDuration || 0]
    );

    return { type, key, score: newScore, delta: scoreDelta, signal: signalType };
  } catch (e) {
    console.error('[updateMemory]', type, key, e.message);
    return null;
  }
}

// ===== 播放记录 =====

async function recordPlay(song, playDuration) {
  try {
    // 输入校验
    if (!song || !validateHash(song.hash)) {
      console.warn('[recordPlay] invalid hash, skipped');
      return false;
    }

    // 播放去重：同一首歌 30 秒内重复播放只记一次
    const now = Date.now();
    const dedupKey = song.hash;
    const lastTime = recentPlays.get(dedupKey) || 0;
    if (now - lastTime < BOUNDARIES.PLAY_DEDUPE_MS) return false;
    recentPlays.set(dedupKey, now);
    // 清理过期去重记录
    if (recentPlays.size > 100) {
      const cutoff = now - BOUNDARIES.PLAY_DEDUPE_MS;
      for (const [k, t] of recentPlays) { if (t < cutoff) recentPlays.delete(k); }
    }

    const ts = new Date();
    const tp = song.trans_param || {};

    const pool = getPool();

    // 1. 写入播放日志（带边界控制：超出最大条数时自动清理最旧的 2000 条）
    await pool.query(
      `INSERT INTO play_history
       (hash, songname, singername, album_name, duration, play_duration, hour, weekday,
        language, is_new, publish_date, album_type, heat, is_original, pay_type, cid, mixsongid, topic_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [song.hash, sanitizeInput(song.songname), sanitizeInput(song.singername),
       sanitizeInput(song.album_name), song.duration || 0, clamp(playDuration || 0, 0, 999999),
       ts.getHours(), ts.getDay(), sanitizeInput(tp.language || ''), song.isnew ? 1 : 0,
       '', '', clamp(song.album_info?.heat || 0, 0, 99999999),
       song.isoriginal ? 1 : 0, song.pay_type || 0, tp.cid || 0,
       Number(song.mixsongid || song.album_audio_id || 0), sanitizeInput(song.topic_url || '', 500)]
    );

    // 播放日志超限自动清理
    const [[{ cnt: histCnt }]] = await pool.query(`SELECT COUNT(*) as cnt FROM play_history`);
    if (histCnt > BOUNDARIES.HISTORY_MAX) {
      await pool.query(`DELETE FROM play_history ORDER BY id ASC LIMIT 2000`);
      console.log(`[recordPlay] cleaned 2000 old records, remaining: ${histCnt - 2000}`);
    }

    // 2. 更新用户画像
    await pool.query(
      `UPDATE user_profile SET total_plays = total_plays + 1, total_listen = total_listen + ? WHERE id = 1`,
      [clamp(playDuration || 0, 0, 999999)]
    );

    // 3. 更新记忆向量（多维学习，限制单次更新数）
    const singer = sanitizeInput(song.singername || '未知', 128);
    const lang = sanitizeInput(tp.language || '', 32);
    const hour = clamp(ts.getHours(), 0, 23);
    const weekday = clamp(ts.getDay(), 0, 6);

    let updateCount = 0;
    await updateMemory('singer', singer, playDuration, song.duration || 0); updateCount++;
    if (lang && updateCount < BOUNDARIES.MEMORY_UPDATE_MAX) {
      await updateMemory('language', lang, playDuration, song.duration || 0); updateCount++;
    }
    if (updateCount < BOUNDARIES.MEMORY_UPDATE_MAX) {
      await updateMemory('hour', String(hour), playDuration, song.duration || 0); updateCount++;
    }
    if (updateCount < BOUNDARIES.MEMORY_UPDATE_MAX) {
      await updateMemory('weekday', String(weekday), playDuration, song.duration || 0); updateCount++;
    }

    return true;
  } catch (e) { console.error('[recordPlay]', e.message); return false; }
}

// ===== 收藏（给记忆大幅加成） =====

async function addFavorite(song) {
  try {
    const tp = song.trans_param || {};
    const pool = getPool();

    await pool.query(
      `INSERT INTO favorites (hash, songname, singername, album_name, duration, language, heat, is_new, mixsongid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [song.hash, song.songname || '', song.singername || '', song.album_name || '',
       song.duration || 0, tp.language || '', song.album_info?.heat || 0, song.isnew || 0,
       Number(song.mixsongid || song.album_audio_id || 0)]
    );

    // 收藏歌手 → 记忆大幅提升
    const singer = song.singername || '未知';
    await updateMemory('fav_singer', singer, 300, 300); // 强信号
    await updateMemory('singer', singer, 300, 300);

    return true;
  } catch { return false; }
}

async function removeFavorite(hash) {
  try {
    const [r] = await getPool().query(`DELETE FROM favorites WHERE hash = ?`, [hash]);
    return r.affectedRows > 0;
  } catch { return false; }
}

async function getHistory(limit = 100, userid = '') {
  try {
    // 按 hash+歌名 去重合并：同一首歌只返回一条，附带播放次数 play_count 与最近播放时间
    const [rows] = await getPool().query(
      `SELECT hash, songname, singername, album_name, duration,
              MAX(play_time) AS play_time, COUNT(*) AS play_count,
              MAX(mixsongid) AS mixsongid
       FROM play_history
       WHERE userid = ?
       GROUP BY hash, songname, singername, album_name, duration
       ORDER BY play_time DESC
       LIMIT ?`, [userid, limit]
    );
    return rows.map((r) => ({
      ...r,
      play_count: Number(r.play_count) || 1,
      play_duration: 0,
    }));
  } catch (e) { console.error('[getHistory]', e.message); return []; }
}

async function getFavorites(userid = '') {
  try {
    const [rows] = await getPool().query(`SELECT * FROM favorites WHERE userid = ? ORDER BY favorited_at DESC`, [userid]);
    return rows;
  } catch { return []; }
}

// ===== 记忆衰减（基于播放次数，不依赖时间周期） =====

/**
 * 清理低于阈值的记忆向量
 * 这个函数不需要定期执行，因为：
 *   - 衰减是基于播放次数而非自然时间
 *   - 用户不打开听歌时，记忆不会衰减
 *   - updateMemory() 时已经处理了衰减
 * 只在启动时运行一次即可
 */
async function decayAllMemories() {
  try {
    const pool = getPool();
    // 获取当前总播放次数
    const [[{ total_plays: totalPlays }]] = await pool.query(
      `SELECT total_plays FROM user_profile WHERE id = 1`
    );
    const tp = totalPlays || 0;

    const [vectors] = await pool.query(
      `SELECT id, vector_type, vector_key, score, play_count_at FROM memory_vectors WHERE score > 0`
    );

    let cleaned = 0;
    for (const v of vectors) {
      const config = DECAY[v.vector_type] || DECAY.singer;
      const playsSince = Math.max(0, tp - (v.play_count_at || 0));
      // 计算衰减后的分数
      const decayed = v.score * Math.exp(-config.rate * playsSince);

      if (decayed < BOUNDARIES.SCORE_DELETE) {
        await pool.query(`DELETE FROM memory_vectors WHERE id = ?`, [v.id]);
        cleaned++;
      } else if (decayed < v.score) {
        await pool.query(`UPDATE memory_vectors SET score = ? WHERE id = ?`, [decayed, v.id]);
      }
    }

    // 防止记忆向量暴涨：超过最大条数时删除最低分的
    const [[{ cnt: memCnt }]] = await pool.query(
      `SELECT COUNT(*) as cnt FROM memory_vectors`
    );
    if (memCnt > BOUNDARIES.MEMORY_MAX) {
      await pool.query(
        `DELETE FROM memory_vectors ORDER BY score ASC LIMIT ?`,
        [memCnt - BOUNDARIES.MEMORY_MAX]
      );
      console.log(`[recommend] Memory trimmed: removed ${memCnt - BOUNDARIES.MEMORY_MAX} low-score vectors`);
    }

    if (cleaned > 0) {
      console.log(`[recommend] Memory decayed: ${cleaned} vectors cleaned from ${vectors.length}`);
    }
  } catch (e) { console.error('[decayAll]', e.message); }
}

// 启动时清理一次，不再定期执行
decayAllMemories();

// ===== AI 推荐评分系统 =====

async function generateRecommendations(userid = '') {
  try {
    const pool = getPool();
    await ensureProfile(userid);

    // 获取用户画像
    const [[profile]] = await pool.query(`SELECT total_plays, total_listen FROM user_profile WHERE userid = ?`, [userid]);
    const totalPlays = profile?.total_plays || 0;
    if (totalPlays < 3) {
      return {
        reason: '播放记录太少，请先多听几首歌 🎧',
        profile: { total_plays: totalPlays, total_listen_min: 0 },
        flame_threshold: HEAT_FLAME,
        memory_summary: null,
        search_keywords: [],
      };
    }

    // ===== 读取记忆向量 =====
    const [memories] = await pool.query(
      `SELECT vector_type, vector_key, score, play_count, total_listen, last_played
       FROM memory_vectors WHERE userid = ? AND score > 0 ORDER BY vector_type, score DESC`, [userid]
    );

    // 按类型分组
    const memMap = {};
    for (const m of memories) {
      if (!memMap[m.vector_type]) memMap[m.vector_type] = [];
      memMap[m.vector_type].push(m);
    }

    // ===== 分析记忆，生成推荐策略 =====
    const topSingers = (memMap.singer || []).slice(0, 5);
    const topLangs = (memMap.language || []).slice(0, 3);
    const topHours = (memMap.hour || []).slice(0, 2);
    const topWeekdays = (memMap.weekday || []).slice(0, 2);
    const topFavSingers = (memMap.fav_singer || []).slice(0, 5);
    const topDecades = (memMap.decade || []).slice(0, 3);

    // 获取收藏歌手列表
    const [favSingers] = await pool.query(
      `SELECT singername, COUNT(*) as cnt FROM favorites
       WHERE userid = ? AND singername != '' AND singername != '未知'
       GROUP BY singername ORDER BY cnt DESC LIMIT 5`, [userid]
    );

    // 获取高热歌曲
    const [hotSongs] = await pool.query(
      `SELECT songname, singername, language, heat, is_new
       FROM play_history
       WHERE userid = ? AND heat > ?
       ORDER BY heat DESC
       LIMIT 10`,
      [userid, HEAT_FLAME]
    );

    // 获取新歌
    const [newSongs] = await pool.query(
      `SELECT songname, singername, album_name, language, play_time
       FROM play_history
       WHERE userid = ? AND is_new = 1
       ORDER BY play_time DESC
       LIMIT 10`, [userid]
    );

    // ===== 生成推荐原因 =====
    let reason = '根据你的听歌偏好为你推荐 🎵';
    let memoryHighlight = [];

    if (topFavSingers.length > 0) {
      reason = `你收藏的歌手 ${topFavSingers[0].vector_key} 是你的最爱，为你推荐`;
      memoryHighlight.push(`最爱歌手: ${topFavSingers[0].vector_key} (记忆分${topFavSingers[0].score.toFixed(1)})`);
    } else if (topSingers.length > 0) {
      const names = topSingers.slice(0, 3).map(s => s.vector_key).join('、');
      reason = `你最近常听 ${names}`;
      memoryHighlight.push(`常听歌手: ${names}`);
    }
    if (topLangs.length > 0) {
      memoryHighlight.push(`偏好语种: ${topLangs.map(l => l.vector_key).join('、')}`);
    }
    if (topHours.length > 0) {
      memoryHighlight.push(`听歌高峰: ${topHours[0].vector_key}:00`);
    }

    // 生成搜索关键词 (优先收藏歌手，其次是常听歌手)
    const combinedSingers = [...topFavSingers, ...topSingers];
    const uniqueSingers = [];
    const seen = new Set();
    for (const s of combinedSingers) {
      if (!seen.has(s.vector_key) && s.vector_key && s.vector_key !== '未知') {
        uniqueSingers.push(s.vector_key);
        seen.add(s.vector_key);
      }
    }
    const searchKeywords = uniqueSingers.slice(0, 3);
    if (topLangs.length > 0) searchKeywords.push(topLangs[0].vector_key + '歌');

    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

    return {
      reason,
      memory_summary: memoryHighlight,
      top_singers: topSingers,
      top_fav_singers: topFavSingers,
      language_prefs: topLangs,
      decade_prefs: topDecades,
      peak_hour: topHours[0]?.vector_key || null,
      peak_weekday: topWeekdays[0]?.vector_key ? `星期${weekdays[topWeekdays[0].vector_key]}` : null,
      hot_songs: hotSongs,
      new_songs: newSongs,
      fav_singers: favSingers,
      total_plays: totalPlays,
      total_listen_min: Math.round((profile?.total_listen || 0) / 60),
      search_keywords: [...new Set(searchKeywords)],
      flame_threshold: HEAT_FLAME,
      flame_fire: HEAT_FIRE,
      flame_blast: HEAT_BLAST,
    };
  } catch (e) {
    console.error('[recommend]', e.message);
    return { reason: '推荐生成失败', profile: {}, flame_threshold: HEAT_FLAME };
  }
}

// ===== 获取用户记忆画像 =====

async function getMemoryProfile(userid = '') {
  try {
    const pool = getPool();
    await ensureProfile(userid);
    const [vectors] = await pool.query(
      `SELECT vector_type, vector_key, score, play_count, last_played
       FROM memory_vectors WHERE userid = ? AND score > 2
       ORDER BY vector_type, score DESC`, [userid]
    );

    const result = {};
    for (const v of vectors) {
      if (!result[v.vector_type]) result[v.vector_type] = [];
      result[v.vector_type].push({
        name: v.vector_key,
        score: parseFloat(v.score.toFixed(1)),
        plays: v.play_count,
        last: v.last_played,
      });
    }

    const [[profile]] = await pool.query(`SELECT * FROM user_profile WHERE userid = ?`, [userid]);
    result._profile = profile;

    return result;
  } catch { return {}; }
}

module.exports = {
  recordPlay,
  addFavorite,
  removeFavorite,
  getHistory,
  getFavorites,
  getProfile: async (userid = '') => {
    try {
      const [[r]] = await getPool().query(`SELECT * FROM user_profile WHERE userid = ?`, [userid]);
      return r || {};
    } catch {
      return {};
    }
  },
  generateRecommendations,
  getMemoryProfile,
  decayAllMemories,
  HEAT_FLAME,
  HEAT_FIRE,
  HEAT_BLAST,
};
