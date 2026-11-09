// 个性化推荐（基于本地 MySQL 播放/收藏记忆，见根目录 recommend_engine.js）
// 路由: /recommend
module.exports = () => {
  return require('../recommend_engine')
    .generateRecommendations()
    .then((rec) => ({
      status: 200,
      body: { code: 0, ...rec },
      cookie: [],
      headers: {},
    }))
    .catch((err) => ({
      status: 500,
      body: { code: 500, error: `推荐生成失败: ${err.message}` },
      cookie: [],
      headers: {},
    }));
};
