// 账号列表（不暴露完整 token）
module.exports = () => {
  const { list } = require('../account_store');
  return { status: 200, body: { code: 0, accounts: list() }, cookie: [], headers: {} };
};
