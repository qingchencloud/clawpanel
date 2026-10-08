# 2026-10-07 上游版本兼容复查

## 版本策略

本次从 ClawPanel 0.21.8 工作区复查上游，并于 2026-10-08 准备 0.21.9 兼容版本。本报告记录本地验证；远程发布状态以对应提交和 tag 的 Actions 结果为准。

| 引擎 | 本次适配目标 | 发布通道 | 策略 |
| --- | --- | --- | --- |
| OpenClaw 官方版 | 2026.9.8 | 稳定版 | 默认推荐版本由 2026.8.2 更新为 2026.9.8 |
| Hermes Agent | 0.21.5 / v2026.9.24 | 稳定版 | 固定源码提交、官方安装器及 SHA256 |
| DeepSeek Harness | 0.2.0-rc.2 | npm latest / next，预发布 | 跟随当前 npm 推荐 RC，不标记为稳定版 |

OpenClaw 2026.10.1-beta.1、DSH 0.2.1-alpha.1 不属于本次推荐或实测目标。
汉化版 OpenClaw 的推荐版本和历史版本策略未改变；没有自动升级用户已安装的引擎。

上游一手资料：

- [OpenClaw 2026.9.8 Release](https://github.com/openclaw/openclaw/releases/tag/v2026.9.8)
- [OpenClaw 2026.9.8 更新说明](https://docs.openclaw.ai/releases/2026.9.8)
- [Hermes Agent 0.21.5 Release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.24)
- [DeepSeek Harness 0.2.0-rc.2 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)
- [DSH npm 元数据](https://registry.npmjs.org/@deepseek-ai/dsh)

## 兼容改动

### OpenClaw

- `openclaw-version-policy.json`、`src/lib/feature-catalog.js`、`scripts/linux-deploy.sh` 同步官方稳定版推荐。
- 新版 npm 包要求 Node `>=24.16.0 <25 || >=26.1.0`。Docker 运行阶段及文档示例升级到 Node 24.16.0；面板前端构建阶段保留原版本。
- 现有 Linux 安装脚本的新内核 Node 版本检查继续覆盖 2026.9.8。
- Docker 构建上下文保留完整引擎后端模块和版本策略，生产镜像包含共享库；排除本机 `output`、`node_modules` 等测试与依赖缓存。
- 保留旧版握手、协议版本 3/4 兼容逻辑及其回归用例，没有通过强制升级来替代握手兼容。

### Hermes

- `scripts/dev-api.js` 与 `src-tauri/src/commands/hermes.rs` 同步稳定版本、不可变提交及安装器校验值。
- Windows 安装阶段增加 `node`、`node-deps`；`repository` 提前到受管 Python 阶段之前。POSIX 阶段增加 `node-deps`。继续跳过全局 PATH 修改及交互配置阶段。
- 运行 PATH 增加 Hermes Home 下的受管 Node，源码 venv 保持优先。
- 能力接口复用本机 API Key 认证：修复新 Gateway 的 `/v1/capabilities` 返回 401。密钥仍在后端注入。
- Web API 调度保留 handler 的 `this` 绑定，修复启动守护与聊天 handler 的同表方法调用。
- 正确读取 `platforms.api_server.port`，其次读取 `.env` / 进程环境中的 `API_SERVER_PORT`，最后兼容旧面板的 `api_server_port`；测试覆盖默认值、越界值及非整数。
- 启动守护修改 `enabled` 并在需要时迁移旧端口别名，保留原字段、端口、host、嵌套未知字段及其他平台配置；备份名称避免同一秒内覆盖。
- 桌面多 Gateway 看板识别默认或命名 Profile 宿主的 `gateway_state.json` 和原生 `served_profiles`，读取实际监听端口，核验 Home 与进程存活，避免重复启动已服务的 Profile；共享宿主统一在服务管理中操作。
- 停止服务不再通过进程镜像名批量终止 `hermes.exe`，不再直接删除共享宿主 PID 文件。保留原生 CLI 的实例身份判定和面板自有子进程管理。
- 更新共享宿主的界面提示与翻译，旧版缺少共享运行态时仍走独立 Gateway 路径。

### DeepSeek Harness

- Web 和 Rust 安装器同步到 `0.2.0-rc.2`。
- 实际新版密码登录返回 `303 Location: ./`，旧面板仅接受 `/`，导致健康识别失败。
- 修复为只接受 `/` 与 `./` 两种根目录跳转，并继续验证认证 Cookie；拒绝跨站、其他路径和带查询参数的跳转。
- 内嵌工作台、Provider 同步、模型切换和本地存储桥接继续复用现有实现，不向浏览器泄露上游认证 Cookie。

## 实际运行验证

全部引擎使用独立测试 Home 和独立本机端口，不修改用户真实引擎配置，不连接先前提供的测试服务器。聊天模型为本地固定响应服务，不调用真实付费 Provider，也不执行 Agent 工具。

### OpenClaw 2026.9.8：通过

- 使用独立 Node 24.16.0 和实际发布的官方 npm 包。
- 通过面板 Web API 写入模型配置，官方 CLI 校验成功。
- 实际 Gateway 启动，收到 challenge，完成面板兼容握手，协商协议版本 4。
- 启动期间短暂 `UNAVAILABLE` 经有界重试恢复；`health`、`status`、`agents.list`、`models.list`、`sessions.list`、`channels.status`、`question.list` 均成功。
- 模型列表可见测试模型，配置读回的 `contextWindow` 为 131072。

### Hermes Agent 0.21.5：通过

- 固定源码提交 `f97608f178d1ffeca59860195ab7da295f7c8e5f`，运行版本读回一致。
- 实际执行官方 Windows 安装器的 `dependencies` 阶段，按上游锁文件安装；`platform-sdks` 阶段无凭证完成，不代表真实渠道 SDK 联调。
- Provider/默认模型配置同步读回一致；Profile 创建和列表读回成功。
- 面板启动实际原生 Gateway，自定义端口 19982 生效。
- `health`、带认证的能力接口、模型列表均成功。
- 原生共享宿主同时服务 `default` 与测试 Profile，`/p/compat-profile/health` 成功。
- 通过面板调用实际 Hermes 聊天，模型请求到达本地测试 Provider 并返回结果。
- 通过面板停止 Gateway，确认目标端口关闭。
- 追加环境变量端口和旧端口别名迁移两组实际运行测试，Provider、Profile、共享宿主、认证、聊天及启停读回全部通过。
- 独立新 Home 实际执行 Windows 管理安装的全部阶段，源码提交、venv、官方 bootstrap marker 和 CLI 版本一致。首轮测试 HTTP 客户端的默认响应头超时后，修正测试客户端并续跑全阶段；未绕过安装器阶段或创建虚假 marker。
- 在新安装的 Home 再次验证配置同步、Profile、共享 Gateway、认证接口、本地模型聊天及停止后的端口关闭，全部成功。

### DeepSeek Harness 0.2.0-rc.2：通过

- 实际受管安装、启动和状态读回成功。
- 模型渠道同步 Provider、模型列表和默认模型成功，后端读回确认。
- 内嵌页面加载成功，响应不向浏览器返回上游认证 Cookie。
- 浏览器操作面板内嵌工作台，将默认模型从 `fixture-b` 切换为 `fixture-a`，刷新后仍保持选择。
- 从内嵌工作台发送消息，实际 DSH 使用 `fixture-a` 请求本地流式模型，页面显示 `COMPATIBILITY_OK` 及完成状态。
- 浏览器控制台错误和警告均为 0。验证使用构建后的真实前端加测试 HTTP 代理，不代表生产部署验收。

## 本地回归与证据

- Node：678 项，677 通过、0 失败、1 跳过。跳过项为 Windows 环境不适用的 POSIX 文件所有者测试。
- Rust：379 项通过；格式、锁文件编译检查、Clippy 警告视为错误检查通过。
- 前端生产构建、Linux 部署脚本 Bash 语法检查、`git diff --check` 通过。
- 完整 Web 发行目录安装生产依赖并启动，`/__api/health` 读回后端 0.21.9，首页及主资源均为 HTTP 200。
- Vite 保留已有的大 chunk 警告，不影响本次构建成功。

新增回归文件：

- `tests/hermes-gateway-port-compat.test.js`
- `tests/hermes-latest-runtime.test.js`

更新现有 Hermes 稳定版、DSH 登录/版本、OpenClaw 版本策略及发布就绪回归用例；Rust 增加根目录重定向、端口、守护配置保留及共享宿主判定用例。

本机忽略目录中的运行证据（不作为发行包内容）：

- `output/compat-2026-10-07/openclaw-runtime-result.json`
- `output/compat-2026-10-07/hermes-runtime-result.json`
- `output/compat-2026-10-07/dsh-runtime-result.json`
- `output/compat-2026-10-07/dsh-browser-result.json`
- `output/playwright/dsh-rc2-chat.png`
- `output/release-0.21.9/hermes-env-runtime-result.json`
- `output/release-0.21.9/hermes-legacy-runtime-result.json`
- `output/release-0.21.9/hermes-fresh-install-result.json`
- `output/release-0.21.9/hermes-runtime-result.json`
- `output/release-0.21.9/web-bundle-runtime-result.json`

## 尚未覆盖的验收

- 发布前必须由同一提交通过现有 GitHub 三平台 CI，以及独立手动 `Runtime Compatibility` 工作流的实际 Docker 镜像构建、Web 健康、OpenClaw 配置与握手验证。本机 Docker daemon 未就绪，不作为容器运行通过证据。
- Linux/macOS/ARM 的全部实际引擎运行仍需专项验收；远程编译及单元测试不替代全部平台的真实引擎端到端验收。
- Hermes 的完整安装已在隔离 Windows Home 执行；Tauri 桌面 UI 的共享宿主操作、非默认 Profile 宿主的真实运行仍需专项验收，后者当前有单元回归覆盖。
- 真实模型 Provider、真实消息渠道账户、一键安装所有渠道、长时间运行及用户故障环境复现尚未验收。
- OpenClaw beta、DSH alpha 未实测；旧引擎主要由既有自动化回归覆盖，不等于重新完成所有旧版端到端测试。

发布应先验证同一提交的两道远程门禁，再打 tag。发行资产及更新清单须在 Release 工作流完成后读回确认；本地通过不等于线上部署验收。
