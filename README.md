# KuGouMusic API

酷狗音乐 NodeJS 版 API

[![](https://img.shields.io/badge/Author-MakcRe-blueviolet?style=for-the-badge '作者')](https://github.com/MakcRe)
![](https://img.shields.io/badge/dynamic/json?label=GitHub%20Followers&style=for-the-badge&query=%24.data.totalSubs&url=https%3A%2F%2Fapi.spencerwoo.com%2Fsubstats%2F%3Fsource%3Dgithub%26queryKey%3DMakcRe&labelColor=282c34&color=181717&logo=github&longCache=true '关注数量')
![](https://img.shields.io/github/stars/MakcRe/KuGouMusicApi.svg?style=for-the-badge&label=Star 'Star数量')
![](https://img.shields.io/github/forks/MakcRe/KuGouMusicApi.svg?style=for-the-badge&label=Fork 'Fork数量')
![](https://img.shields.io/github/issues/MakcRe/KuGouMusicApi.svg?style=for-the-badge&label=Issues 'Issues数量')
![](https://img.shields.io/github/contributors/MakcRe/KuGouMusicApi?style=for-the-badge '贡献者')
![](https://img.shields.io/github/repo-size/MakcRe/KuGouMusicApi?style=for-the-badge&label=files&color=cf8ef4&labelColor=373e4dl '文件大小')
![](https://img.shields.io/github/languages/code-size/MakcRe/KuGouMusicApi?color=blueviolet&style=for-the-badge '代码大小')

[//]: # '<br>'

![](https://img.shields.io/github/package-json/v/MakcRe/KuGouMusicApi?longCache=true&style=for-the-badge)
![](https://img.shields.io/badge/Node-12+-green.svg?longCache=true&style=for-the-badge)
![](https://img.shields.io/badge/License-mit-blue.svg?longCache=true&style=for-the-badge)

## 灵感来自

[Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)

## 环境要求

需要 NodeJS 12+ 环境

## 工作原理

跨站请求伪造 (CSRF), 伪造请求头 , 调用官方 API

## 免责声明

> 1. 本项目仅供学习使用，请尊重版权，请勿利用此项目从事商业行为及非法用途!
> 2. 使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在 24 小时内清除使用本项目的过程中所产
>    生的版权数据。
> 3. 由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害（包括但不限于因商誉损失、停
>    工、计算机故障或故障引起的损害赔偿，或任何及所有其他商业损害或损失）由使用者负责。
> 4. **禁止在违反当地法律法规的情况下使用本项目。** 对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担，本
>    项目不承担由此造成的任何直接、间接、特殊、偶然或结果性责任。
> 5. 音乐平台不易，请尊重版权，支持正版。
> 6. 本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。
> 7. 如果官方音乐平台觉得本项目不妥，可联系本项目更改或移除。

### 安装

```shell
$ git clone git@github.com:MakcRe/KuGouMusicApi.git
$ cd KuGouMusicApi
$ npm install
```

### 使用接口为概念版

```
$ 复制 .env.example 为 .env，并且把里面的 `platform=''` 改为 `platform=lite`
$ 注意不同版本的平台的 token 是不通用的。
```

### 运行

```shell
$ npm run dev
```

服务器启动默认端口为 3000, 若不想使用 3000 端口 , 可使用以下命令 : Mac/Linux

```shell
$ PORT=4000 npm run dev
```

windows 下使用 git-bash 或者 cmder 等终端执行以下命令 :

```shell
$ set PORT=4000 && npm run dev
```

windows 下使用 PowerShell 等终端执行以下命令 :

```shell
$ $Env:PORT=4000; npm run dev
```

服务器启动默认 host 为 localhost,如果需要更改, 可使用以下命令 : Mac/Linux

```shell
$ HOST=127.0.0.1 npm run dev
```

windows 下使用 git-bash 或者 cmder 等终端执行以下命令 :

```shell
$ set HOST=127.0.0.1 && npm run dev
```

windows 下使用 PowerShell 等终端执行以下命令 :

```shell
$ $Env:HOST=127.0.0.1; npm run dev
```

### 代理配置

如需通过 HTTP 代理请求酷狗接口，可在启动前设置 `KUGOU_API_PROXY` 环境变量，例如:

```shell
$ $Env:KUGOU_API_PROXY='http://127.0.0.1:7890'; npm run dev
```

也可以在启动命令后追加代理参数:

```shell
$ node app.js --proxy=http://127.0.0.1:7890
```

## OpenClaw 自动化脚本

新增脚本：`scripts/kugou_assistant.js`，用于自动化登录、状态检查、续期、每日 VIP、搜索下载与可选上传。

### 常用命令

```shell
# 1) 生成微信扫码二维码（会输出 uuid、扫码链接、二维码图片文件路径）
$ npm run kugou:assistant -- wx-login-init

# 2) 扫码后等待登录完成（自动换取 token、注册设备 dfid、刷新登录）
$ npm run kugou:assistant -- wx-login-wait --timeout 180

# 3) 检查登录状态
$ npm run kugou:assistant -- status

# 4) 刷新登录（续期）
$ npm run kugou:assistant -- refresh

# 5) 每日领取 VIP（默认当天，自动执行 upgrade）
$ npm run kugou:assistant -- claim-vip

# 6) 查看酷狗云盘列表
$ npm run kugou:assistant -- cloud-list --page 1 --pagesize 30

# 7) 下载酷狗云盘歌曲（hash 来自 cloud-list）
$ npm run kugou:assistant -- cloud-download --hash <HASH> --name '云盘歌曲名'

# 8) 搜索（公共搜索源）
$ npm run kugou:assistant -- search --keyword 海阔天空 --pagesize 5

# 9) 下载最高可用音质（自动挑选可用最高码率）
$ npm run kugou:assistant -- download --keyword 海阔天空 --singer BEYOND

# 10) 下载后执行上传命令（通过环境变量 FILE_PATH / FILE_NAME 传递文件信息）
$ npm run kugou:assistant -- download --keyword 海阔天空 --singer BEYOND --upload-cmd 'rclone copy "$FILE_PATH" your-remote:music/'

# 11) 下载后直接上传到 AList（openalist:5244，不经过 alist-encrypt）
# 可用环境变量：ALIST_USER / ALIST_PASS / ALIST_URL / ALIST_DIR
$ ALIST_USER='admin' ALIST_PASS='你的密码' npm run kugou:assistant -- download --keyword 海阔天空 --singer BEYOND --alist-upload --alist-url http://127.0.0.1:5244 --alist-dir /156天翼云盘/kugou-openalist
```

### 说明

- 登录态默认保存到 `./.kugou/session.json`
- 下载目录默认 `./.kugou/downloads`
- `--alist-upload` 走 AList 官方 API：`/api/auth/login` + `/api/fs/put`
- 默认 AList 上传目录是 ` /156天翼云盘/kugou-openalist `，与 `alist-encrypt` 路径隔离
- 当前文档与仓库实现仅包含“获取云盘列表/获取云盘歌曲 URL”，未提供“上传到酷狗云盘”接口
- 若需对接 OpenClaw，可直接把上面的命令作为任务命令调用

## Docker Compose 部署（GHCR 镜像）

项目已支持通过 GitHub Actions 自动构建并发布 Docker 镜像到 GHCR。

### GitHub Actions 构建镜像

- Workflow: `.github/workflows/docker-image.yml`
- 触发条件: push 到 `main` 或 push `v*` tag
- 镜像地址: `ghcr.io/<owner>/kugoumusicapi:latest`

> 若仓库公开并且 GHCR 包也设置为公开，本地可直接拉取镜像。

### 本地运行

1. 复制环境变量文件:

```shell
$ cp .env.example .env
```

2. 如需指定镜像拥有者，设置 `GHCR_OWNER`（默认 `makcre`）:

```shell
$ export GHCR_OWNER=makcre
```

3. 拉取并启动:

```shell
$ docker compose pull
$ docker compose up -d
```

4. 查看日志:

```shell
$ docker compose logs -f
```

5. 停止服务:

```shell
$ docker compose down
```

## Vercel 部署

### 操作方法

1. fork 此项目
2. 在 Vercel 官网点击 `New Project`
3. 点击 `Import Git Repository` 并选择你 fork 的此项目并点击 `import`
4. 点击 `PERSONAL ACCOUNT` 的 `select`
5. 直接点 `Continue`
6. 若需要部署版本为概念版（不需要该步骤可以跳过），在 `Environment Variables` 添加 `key` 为 `platform`，`Value (Will Be Encrypted)` 为 `lite` 然后点击
   `Add`
7. `PROJECT NAME`自己填,`FRAMEWORK PRESET` 选 `Other` 然后直接点 `Deploy` 接着等部署完成即可

## 功能特性

1. 登录
2. 刷新登录
3. 发送验证码
4. dfid 获取
5. 获取用户额外信息
6. 获取用户 vip 信息
7. 获取用户歌单
8. 获取用户关注歌手
9. 获取用户听歌历史排行
10. 获取用户最近听歌历史
11. 获取继续播放信息（对应手机版首页显示继续播放入口）
12. 收藏歌单/新建歌单
13. 取消收藏歌单/删除歌单
14. 对歌单添加歌曲
15. 对歌单删除歌曲
16. 新碟上架
17. 专辑信息
18. 专辑详情
19. 专辑音乐列表
20. 获取音乐 URL
21. 获取歌曲高潮部分
22. 搜索
23. 默认搜索关键词
24. 综合搜索
25. 热搜列表
26. 搜索建议
27. 歌词搜索
28. 获取歌词
29. 歌单分类
30. 歌单
31. 主题歌单
32. 音效歌单
33. 获取歌单详情
34. 获取歌单所有歌曲
35. 获取歌单所有歌曲（新版）
36. 相似歌单
37. 获取主题歌单所有歌曲
38. 获取主题音乐
39. 获取主题音乐详情
40. 歌曲推荐
41. 获取歌手和专辑图片
42. 获取歌手图片
43. 获取音乐相关信息
44. 获取更多音乐版本
45. 获取音乐伴奏信息
46. 获取音乐 k 歌数量
47. 获取音乐详情
48. 获取音乐专辑/歌手信息
49. 私人 FM(对应手机和 pc 端的猜你喜欢)
50. banner
51. 乐库 banner
52. 乐库电台
53. 乐库
54. 电台 - 推荐
55. 电台
56. 电台 - 图片
57. 电台 - 音乐列表
58. 编辑精选
59. 编辑精选数据
60. 编辑精选歌单
61. 编辑精选专区
62. 编辑精选专区详情
63. 领取 VIP（需要登陆，该接口为测试接口）
64. 获取歌手列表
65. 获取歌手详情
66. 获取歌手专辑
67. 获取歌手单曲
68. 获取歌手 MV
69. 关注歌手
70. 取消关注歌手
71. 获取关注歌手新歌
72. 获取视频 url
73. 获取歌曲 MV
74. 获取视频相关信息
75. 获取视频详情
76. 新歌速递
77. 场景音乐列表
78. 场景音乐详情
79. 获取场景音乐讨论区
80. 获取场景音乐模块 Tag
81. 获取场景音乐歌单列表
82. 获取场景音乐视频列表
83. 获取场景音乐音乐列表
84. 每日推荐
85. 历史推荐
86. 风格推荐
87. 排行列表
88. 排行榜推荐列表
89. 排行榜往期列表
90. 排行榜信息
91. 排行榜歌曲列表
92. 歌曲评论
93. 歌曲评论-根据分类返回
94. 歌曲评论-根据热词返回
95. 楼层评论
96. 歌单评论
97. 专辑评论
98. 歌曲曲谱
99. 曲谱详情
100. 推荐曲谱
101. 曲谱合集
102. 曲谱合集详情
103. 提交听歌历史
104. 获取服务器时间
105. 刷刷
106. AI 推荐
107. 频道 - 获取用户所有频道
108. 频道 - 详情
109. 频道 - 频道安利
110. 频道 - 相似频道
111. 频道 - 订阅
112. 频道 - 音乐故事
113. 频道 - 音乐故事详情
114. 动态 - 最常访问
115. 获取用户公开的音乐
116. 听书 - 每日推荐
117. 听书 - 排行榜推荐
118. 听书 - VIP 推荐
119. 听书 - 每周推荐
120. 听书 - 专辑详情
121. 听书 - 专辑音乐列表
122. 歌曲详情 - 歌曲成绩单
123. 歌曲详情 - 歌曲成绩单详情

## License

[The MIT License (MIT)](https://github.com/MakcRe/KuGouMusicApi/blob/main/LICENSE)
