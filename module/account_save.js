// 保存账号（登录成功后由前端调用）
module.exports = (params) => {
  const { save } = require('../account_store');
  const r = save(params.userid, params.token, params.nickname);
  return {
    status: r.ok ? 200 : 400,
    body: { code: r.ok ? 0 : 400, ...r },
    cookie: [],
    headers: {},
  };
};
