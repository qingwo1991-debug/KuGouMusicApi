// 歌单同步：拉取当前账号的歌单列表 + 每个歌单的歌曲，保存到 .kugou/playlists.json
// 路由: /playlist/sync
const fs = require('node:fs');
const path = require('node:path');

function dataDir() {
  return path.join(process.cwd(), '.kugou');
}

async function fetchPlaylists(params, useAxios) {
  const userid = params?.cookie?.userid || params?.userid || 0;
  const token = params?.cookie?.token || params?.token || '';
  if (!userid || !token) throw new Error('请先登录酷狗账号');
  const resp = await useAxios({
    url: '/v7/get_all_list',
    encryptType: 'android',
    method: 'post',
    data: { userid, token, total_ver: 979, type: 2, page: 1, pagesize: 100 },
    params: { plat: 1, userid: Number(userid), token },
    cookie: params.cookie || {},
    headers: { 'x-router': 'cloudlist.service.kugou.com' },
  });
  const data = (resp.body && resp.body.data) || {};
  const arr = data.info || data.lists || data.list || [];
  return arr
    .map((p) => ({
      id: p.global_collection_id || p.listid || p.list_id || String(p.specialid || ''),
      name: p.listname || p.name || p.title || '',
      song_count: p.songcount || p.song_count || p.count || 0,
      is_private: p.is_private || 0,
    }))
    .filter((p) => p.id);
}

async function fetchTracks(gid, params, useAxios) {
  const resp = await useAxios({
    url: '/pubsongs/v2/get_other_list_file_nofilt',
    method: 'GET',
    encryptType: 'android',
    params: {
      area_code: 1,
      begin_idx: 0,
      plat: 1,
      type: 1,
      mode: 1,
      personal_switch: 1,
      extend_fields: 'abtags,hot_cmt,popularization',
      pagesize: 500,
      global_collection_id: gid,
    },
    cookie: params.cookie || {},
  });
  const data = (resp.body && resp.body.data) || {};
  const arr = data.info || data.lists || data.songs || [];
  return arr.map((s) => ({
    hash: s.hash || s.FileHash || '',
    name: s.songname || s.SongName || s.filename || s.name || '',
    singer: s.singername || s.SingerName || s.singer_name || '',
    album: s.album_name || s.albumname || s.AlbumName || '',
    duration: s.duration || 0,
    mixsongid: s.mixsongid || s.album_audio_id || 0,
  }));
}

module.exports = async (params, useAxios) => {
  try {
    const playlists = await fetchPlaylists(params, useAxios);
    const result = {
      syncedAt: new Date().toISOString(),
      userid: params?.cookie?.userid || '',
      playlists: [],
    };
    for (const pl of playlists) {
      let tracks = [];
      try {
        tracks = await fetchTracks(pl.id, params, useAxios);
      } catch (e) {
        /* 单个歌单失败不影响整体 */
      }
      result.playlists.push({ ...pl, tracks });
    }
    const dir = dataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'playlists.json'), JSON.stringify(result, null, 2));
    return {
      status: 200,
      body: {
        code: 0,
        count: result.playlists.length,
        totalTracks: result.playlists.reduce((n, p) => n + p.tracks.length, 0),
        playlists: result.playlists.map((p) => ({
          id: p.id,
          name: p.name,
          song_count: p.song_count,
          tracks: p.tracks.length,
        })),
      },
      cookie: [],
      headers: {},
    };
  } catch (e) {
    return { status: 401, body: { code: 401, error: e.message || '同步失败' }, cookie: [], headers: {} };
  }
};
