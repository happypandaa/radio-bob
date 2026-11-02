# Radio Bob 开发说明

本文件只写 Radio Bob 自己的代码与数据。平台接入规则以熊猫小抽屉随附的 skill 为准，这里不重复。

## 代码结构

| 路径 | 职责 |
| --- | --- |
| `server/managed.mjs` | 平台受管单入口：遵守平台控制协议，读取平台注入的目录与环境变量，启动业务服务器。 |
| `server/index.mjs` | 独立运行入口（`npm run dev` / `npm start`），固定使用本机 8080 网页 + 3000 音乐服务。 |
| `server/app.mjs` | 业务服务器工厂，不在导入时打开存储或监听端口，由入口传入目录与运行方式。 |
| `server/claude.mjs` | AI 适配器：调用 DeepSeek 的 Anthropic Messages 兼容接口选歌、生成串词。 |
| `server/tts.mjs` | Fish Audio 语音合成与 MP3 缓存。 |
| `server/music.mjs` | 音乐 HTTP 传输（独立模式）。 |
| `server/music-sdk.mjs` | 音乐 SDK 同进程函数传输（受管模式），只加载所需模块。 |
| `server/music-session.mjs` | 网易云登录会话的私有文件存储。 |
| `server/store.mjs` | 业务数据存储（SQLite + 品味文件）。 |
| `server/match.mjs` | 曲库匹配，避开 Live、伴奏、翻唱等版本。 |
| `server/router.mjs` | 简单指令识别（暂停、下一首等）。 |
| `public/` | 前端：`index.html`、`app.js`、`styles.css` 与本地资源。 |
| `test/` | 自动化测试，使用模拟服务和临时目录，不调用真实 AI/Fish，不使用真实密钥。 |
| `scripts/dev.mjs` | 独立模式的启动脚本。 |

## 数据存在哪些文件里

运行目录由平台注入（`APP_DATA_DIR`），即项目的 `data/`。业务数据都写在这个目录下：

| 文件/目录 | 内容 |
| --- | --- |
| `data/state.db` | SQLite：聊天记录、播放记录、节目计划、队列、音量等。 |
| `data/profile/taste.md` | 用户保存的音乐品味。 |
| `data/credentials/netease-session/` | 网易云登录会话（Cookie），目录 0700、文件 0600，独立于业务数据库。 |

缓存和临时文件在平台注入的 `APP_CACHE_DIR` / `APP_TEMP_DIR`：

| 目录 | 内容 |
| --- | --- |
| `APP_CACHE_DIR` | Fish 口播 MP3 缓存，按内容、模型和音色复用。 |
| `APP_TEMP_DIR` | 音乐 SDK 的临时状态与请求辅助文件。 |

独立模式（不走平台）仍沿用旧布局：`.data/state.db`、`user/taste.md`、`.data/tts/`。

## 网易云登录会话放在哪

受管模式下，登录 Cookie 保存在 `APP_DATA_DIR/credentials/netease-session/session.cookie`，由 `server/music-session.mjs` 管理：私有目录权限 0700、文件 0600，原子写入，拒绝符号链接，退出或会话过期即清除。它不写入业务 SQLite，也不返回给页面、状态接口或事件流。

独立模式兼容旧方式：登录 Cookie 存在业务库 `settings` 表的 `musicCookie` 键。

## 怎么跑测试

```sh
npm test
```

测试覆盖 API 请求地址、认证、模型与提示词、结构化输出兼容、拒绝/截断、错误脱敏、超时与响应限额，以及音乐、语音和存储行为。全部使用模拟服务与临时目录，不发起真实外部请求，也不使用真实密钥。
