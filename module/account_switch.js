// 切换账号：把目标账号的 token/userid 写回 Cookie
module.exports = (params) => {
  const { switchTo } = require('../account_store');
  const r = switchTo(params.userid);
  if (!r.ok) {
    return { status: 400, body: { code: 400, ...r }, cookie: [], headers: {} };
  }
  const cookie = [`token=${r.account.token}`, `userid=${r.account.userid}`];
  return {
    status: 200,
    body: { code: 0, userid: r.account.userid, nickname: r.account.nickname },
    cookie,
    headers: {},
  };
};
