# Radio Bob

本机运行的个人 AI 电台：用自然语言选歌，听 Bob 的中文串词，也可以直接搜歌、管理待播队列、保存音乐品味。当前是个人使用版本，没有部署到公网。

## 平台受管 Node 试验

新增 `server/managed.mjs` 和实验 `local-app.json`，用于验证平台统一启动、停止、状态与私有数据目录。**该清单不是当前可安装格式，也不是完整可分发包**：运行依赖仍位于原项目根 `node_modules`，前端目前使用站点根 `/api`、`/tts`，尚未完成平台代理基址适配、安装/备份/更新/OS 凭据库及真实账号链路验收。

原 `npm run dev` / `npm start` 仍按下文独立运行，不读取实验清单。受管入口不加载原项目 `.env`、`.data` 或 `user/taste.md`；只有收到实例初始化后才打开平台注入的隔离目录。网易云 SDK 在同一 Node 进程调用，不启动第二个音乐 HTTP 服务；所有后端 HTTP 路由均需实例认证，不提供静态网页。

受管试验已禁用音乐扫码登录、登录轮询和注销，并且不读取业务库中的音乐 Cookie；界面按后端声明显示 GUEST 并禁用登录。原独立版仍将 Cookie 放在业务库，尚不符合平台秘密存储/归档方案；**请勿在受管试验使用真实音乐账号或将原 `.data` 指向试验目录**。

首次验证只用人工数据检查生命周期。2026-10-20 后续按用户授权，使用临时环境注入的 DeepSeek 凭据与全新数据目录，通过一次真实 `deepseek-flash` 节目生成、曲库匹配、浏览器试听和可匿名播放的完整音源样本；未配置 Fish。真实试用发现并修复了函数式 SDK 缺 xeapi 公钥导致的播放失败。浏览器使用一次性本机适配器，不代表平台正式代理或安装功能已交付，密钥未保存到项目。

使用边界见[受管试验使用说明](docs/MANAGED_USER_GUIDE.md)，协议和验证方式见[开发说明](docs/MANAGED_DEVELOPMENT.md)。

`local-app.json` 目前只向平台声明六项用户配置：AI 服务地址、AI 密钥、AI 模型，以及可选的 Fish 语音密钥、音色 ID、语音模型。AI 地址与模型预填已验证的 DeepSeek 兼容地址和 `deepseek-flash`，AI 密钥为必填且没有默认值；未配置 Fish 时保留文字和音乐。每项都有中文用途、不填影响、获取步骤及官方帮助链接。清单只写配置要求，不写真实密钥；可视化填写与秘密保存界面仍待平台实现。AI 版标准入口需先完成清单校验，底层无密钥的生命周期测试不代表标准应用启动就绪。

## 启动

需要 **Node.js 24 或更新版本**，以及所选 AI 服务的 API 凭据。Node 后端直接请求 AI 接口，无需安装或登录 Claude Code。

```sh
cd radio-bob
npm install
npm run dev
```

浏览器打开 [Radio Bob](http://localhost:8080)。启动命令同时管理两个本地服务：

- `8080`：Radio Bob 界面与应用服务。
- `3000`：社区网易云音乐接口服务；已运行时会复用。

两者默认只监听 `127.0.0.1`。关闭终端中的任务或按 `Ctrl+C` 停止本次启动的服务。

## 独立运行配置

以下是原独立运行入口的配置，保留历史变量兼容，不是平台首次配置表单。配置保存在项目根目录 `.env`，修改后重新启动。已有文件直接编辑；新机器上可以参考 `.env.example` 创建，保留自己填写的密钥。平台新实例的六项声明及不同默认模型见上面的受管说明，不读取这里的原实例配置。

| 配置 | 用途 |
| --- | --- |
| `CLAUDE_MODE=api` | 直接请求 AI API；CLI 模式已移除，不启动 Claude Code 子进程。 |
| `ANTHROPIC_BASE_URL` | Anthropic Messages 兼容接口根地址。此项目沿用 `https://api.deepseek.com/anthropic`；未配置时为官方 Anthropic 地址。 |
| `CLAUDE_MODEL` | 明确指定模型；未填写时沿用启动环境的 `ANTHROPIC_MODEL`。当前为 `deepseek-v4-pro`。 |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | 服务端 API Key 或 Bearer token，二者选择一项。优先使用 API Key；不读取 Claude Code 登录凭据。 |
| `CLAUDE_API_EFFORT=max` | 当前沿用原配置的推理级别；也可从启动环境的 `CLAUDE_CODE_EFFORT_LEVEL` 继承。 |
| `CLAUDE_MAX_TOKENS=8192` | 单次响应的最大 token 预算，包含模型思考所需空间；输出长度仍接受本地业务校验。 |
| `CLAUDE_STRUCTURED_OUTPUT=auto` | 官方 Anthropic 启用原生结构化输出；DeepSeek 兼容接口使用原业务提示词和本地 JSON 校验。也可明确设置 `true` 或 `false`。 |
| `FISH_API_KEY` | Fish Audio 密钥，用于合成主持声音。 |
| `FISH_MODEL=s2.1-pro-free` | 默认选择免费开发型号；可用性、额度和频率限制以 Fish 服务为准。 |
| `FISH_REFERENCE_ID` | 音色 ID，可以留空使用默认声音；它不是另一把密钥。 |
| `NETEASE_API_BASE_URL=http://127.0.0.1:3000` | 本地音乐接口地址。 |
| `PORT=8080` | Radio Bob 端口。 |

当前沿用原 Claude Code 配置背后的 DeepSeek V4 Pro 服务、API token 与 `max` 推理级别，直接调用 `/anthropic/v1/messages`。`[1m]` 是 Claude Code 的上下文标签，Node 请求会像原 CLI 一样移除该标签；底层模型保持 `deepseek-v4-pro`。业务系统提示词、音乐品味与历史的组织方式、节目 JSON 格式保持一致，生成内容仍可能因模型随机性及客户端差异而不同。

API 凭据只在 Node 后端使用，可来自本地 `.env` 或启动环境。现有启动环境的 `ANTHROPIC_AUTH_TOKEN` 可继续使用，无需复制到浏览器。原 Claude Code 的订阅登录和 OAuth 会话不会被转换为 API Key。切换供应商时需同时核对地址、模型、认证和结构化输出支持，应用不会自动换模型或重试生成。

状态检查只确认 API 配置有效，尚未发起模型请求时不代表已验证远端连通。生成过程处理接口拒绝、输出截断、限流、超时、响应过大与 JSON 校验失败。思考内容不会进入业务记录；歌曲与口播仅在完整通过校验后使用。暂停、继续、切歌等本地控制仍无需请求模型。

Fish 密钥只在服务端使用。没有配置或合成失败时，歌曲与文字串词仍可使用；点击消息下方的“REPLAY”可以重试合成或播放已缓存口播。[Fish 使用说明](https://docs.fish.audio/developer-guide/getting-started/quickstart)

## 音乐怎么接

不用申请网易云 API Key。项目在本机运行 `@neteasecloudmusicapienhanced/api` 社区接口，负责搜索和取得播放地址；它不是网易云官方开放 API。

先直接搜索一首歌测试。需要连接账号时，点击界面的网易云连接入口，用网易云音乐 App 扫码并确认。应用只在本机保存登录会话，不需要把账号密码写入 `.env`。

搜索到歌曲不等于可以完整播放。是否可播、是否只有试听，取决于歌曲版权与账号权限；程序会标记试听，不提供解锁或绕过会员限制。社区接口也可能随上游变化而失效。

## 日常使用

1. 在品味设置中写下喜欢的歌手、风格和不喜欢的类型。
2. 输入“给我三首适合专注工作的歌”等需求，等待歌曲卡片和主持串词。
3. 用播放器控制播放、暂停和切歌，或直接输入“暂停”“下一首”等简单指令。
4. 搜索结果可以直接播放或加入队列。浏览器如果阻止自动播放，点击播放按钮即可。

## 本地数据与范围

| 位置 | 内容 |
| --- | --- |
| `.env` | 服务密钥与配置，已被 Git 忽略。 |
| `user/taste.md` | 你保存的音乐品味。 |
| `.data/state.db` | 聊天、播放记录、节目计划、队列和网易云登录会话。 |
| `.data/tts/` | 缓存的主持 MP3；相同内容、型号和音色会复用。 |
| `.data/claude/` | 原 CLI 的历史工作目录；升级保留，新 API 模式不再创建或使用。 |
| `.data/music/` | 音乐服务工作目录与临时数据。 |

`.data/` 已被 Git 忽略，数据库和语音文件限制为当前用户访问。程序在本机运行，模型与语音请求仍会发送到各自配置的外部服务。

目前没有实现麦克风输入、天气、日历、定时节目、客厅音响或多设备同步。模型选曲会经过曲库匹配，但不保证每首推荐都有可播放音源。网络或额度错误可以稍后重试。

## 测试

```sh
npm test
```

自动化测试使用模拟服务和临时目录，不调用真实 AI 或 Fish 生成服务，也不使用真实密钥。覆盖 API 请求地址、认证、模型与提示词、上下文、结构化输出兼容、拒绝/截断、错误脱敏、超时和响应限额，以及既有音乐、语音和存储行为。

## API 迁移验证

- 修改范围：Node AI 适配器、启动配置、状态文案、配置示例及 API 回归测试。没有新增依赖。
- 数据兼容：数据库/schema 无变化；现有音乐品味、聊天、队列、音乐账号会话、音频缓存及历史 CLI 目录保留。
- 自动化检查：`npm test` 25/25 通过；`server/claude.mjs`、`server/index.mjs` 和 `public/app.js` 语法检查通过。系统提示词和上下文构造函数与迁移前逐字比较一致。
- 真实 API：用空品味、空历史的独立测试请求直接调用现有 DeepSeek V4 Pro、`max` 推理级别，约 7.1 秒返回完整节目；本地校验通过，推荐为周杰伦《稻香》，口播 33 字。该请求没有写入业务聊天、队列或播放记录，也没有调用 Fish。
- 运行验证：已重启原本机服务，`/api/status` 确认 `mode: api`、`model: deepseek-v4-pro`、`provider: api.deepseek.com`；状态、业务数据和页面入口均返回 HTTP 200。重启前后公开业务状态摘要完全一致，8 条消息、3 首队列及当前歌曲保留。
- 浏览器验证：独立页面显示 `CONNECTED`、原聊天与 3 首队列；没有刷新原有页面或提交新聊天。没有重新验收实际音频播放、新 Fish 口播生成或完整的网页点歌流程。
- 已知边界：API 配置检查不发起模型请求；真实模型请求仍依赖网络、服务额度与启动环境中的 API 凭据。此次验证确认节目生成可用，不承诺每次模型输出逐字一致。DeepSeek 的 Messages 兼容接口不保证原生 JSON Schema，所有结果仍必须通过本地完整校验。

## 界面与外观

界面以用户提供的 Claudio 软件深色、浅色和资料卡截图为视觉参考。左上角头像或 Radio Bob 标题打开资料卡，EDIT TASTE 进入品味和自动口播设置。DARK / LIGHT 切换主题并保存在浏览器；SHOW / HIDE 展开或收起队列；FAV 查看本机浏览器收藏。

字体、头像和图标在本地提供；资源来源见 `public/assets/ASSETS.md`。辅助等宽字体按截图匹配，原软件 CSS 未公开，因此不承诺原始字体文件完全相同。视觉对照与回归结果见 `design-qa.md`。

### Bob DJ 角色（2026-10-22）

顶部品牌、DJ 资料卡和聊天消息使用原创几何电台头像 `public/assets/bob-avatar.svg`，保留透明背景与像素边缘渲染。公开版本已替换电影角色参考头像，移除旧猫头像与截图提取纹理。

`server/claude.mjs` 的实际 AI 请求已接入 Bob 角色：温厚、松弛、简短的中文口播，以 Grateful Dead、The Incredible String Band、Muddy Waters 为音乐品味锚点，同时优先回应用户需求。保留每次 1–5 首、默认 3 首、30–100 字口播和四字段 JSON 契约；AI 先推荐，应用随后验证曲库与可播性。新设定用于之后生成的节目，已有聊天与队列保留，没有数据迁移或 schema 变更。

本次验证：50/50 自动化测试通过，前后端 JavaScript 语法检查通过；本机界面及头像资源均返回 HTTP 200，浏览器确认顶部、聊天和资料卡显示新头像。未发起真实模型选曲或 Fish 语音合成请求。

## License

Original project code and original vector assets are licensed under the [MIT License](LICENSE). Third-party fonts and icons retain their own licenses; see [asset credits](public/assets/ASSETS.md).
