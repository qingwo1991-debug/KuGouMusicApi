// 删除账号
module.exports = (params) => {
  const { remove } = require('../account_store');
  const r = remove(params.userid);
  return { status: 200, body: { code: 0, ...r }, cookie: [], headers: {} };
};
