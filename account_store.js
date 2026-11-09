// 多账号存储：保存在 .kugou/accounts.json（与 session.json 同级，随数据卷持久化）
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(process.cwd(), '.kugou');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

function readStore() {
  try {
    const s = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (s && typeof s === 'object' && s.accounts) return s;
    return { active: '', accounts: {} };
  } catch {
    return { active: '', accounts: {} };
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(store, null, 2));
}

// 列表（不暴露完整 token，只给尾部用于识别）
function list() {
  const store = readStore();
  return Object.values(store.accounts).map((a) => ({
    userid: a.userid,
    nickname: a.nickname || '',
    tokenTail: a.token ? String(a.token).slice(-6) : '',
    isActive: a.userid === store.active,
    addedAt: a.addedAt || '',
  }));
}

function getActive() {
  const store = readStore();
  return store.accounts[store.active] || null;
}

function save(userid, token, nickname) {
  const store = readStore();
  const uid = String(userid || '').trim();
  const tok = String(token || '').trim();
  if (!uid || !tok) return { ok: false, error: 'userid/token 不能为空' };
  store.accounts[uid] = {
    userid: uid,
    token: tok,
    nickname: nickname ? String(nickname) : '',
    addedAt: new Date().toISOString(),
  };
  if (!store.active || !store.accounts[store.active]) store.active = uid;
  writeStore(store);
  return { ok: true, userid: uid };
}

function switchTo(userid) {
  const store = readStore();
  const uid = String(userid || '').trim();
  if (!store.accounts[uid]) return { ok: false, error: '账号不存在' };
  store.active = uid;
  writeStore(store);
  return { ok: true, account: store.accounts[uid] };
}

function remove(userid) {
  const store = readStore();
  const uid = String(userid || '').trim();
  delete store.accounts[uid];
  if (store.active === uid) store.active = Object.keys(store.accounts)[0] || '';
  writeStore(store);
  return { ok: true };
}

module.exports = { list, getActive, save, switchTo, remove };
