# 更新日志

本项目的所有重要变更都将记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.9.3] - 2026-03-16

### 修复 (Fixes)

- **仪表盘版本显示"未知"** — 修复 coreP Promise 解构顺序错误（config 和 version 互换），导致版本卡片无法正确读取版本信息
- **Agent 管理"暂无 Agent"** — OpenClaw 的 main agent 是隐式的（不在 agents.list 中），list_agents 现在始终自动插入 main agent
- **Agent 模型显示 [object Object]** — 正确解析 model 对象的 primary 字段，兼容字符串和对象两种格式
- **定时任务触发/编辑/删除失败** — cron.run/update/remove RPC 参数从 id 修正为 jobId，匹配 Gateway schema
- **聊天会话列表消失** — 恢复 chat header 中的 sidebar toggle 按钮（PR#88 将按钮移入 sidebar 内导致折叠后无法展开）
- **Gateway 启动失败 Unknown config keys** — stripUiFields 现在清理根层级的 ClawPanel 内部字段（version info），防止污染 openclaw.json
- **Docker 安装超时** — npm 镜像源不再 fallback 到海外 registry.npmjs.org，优先使用国内 npmmirror
- **SkillHub CLI 检测误报"请先安装"** — 检测参数从 --version 修正为 --cli-version
- **消息渠道配置被仪表盘覆盖** — 仪表盘自愈逻辑用缓存 config 覆盖文件导致 channels 丢失，现在先读取最新配置再 patch

### 改进 (Improvements)

- **ARM 设备性能优化** — in-flight 请求去重防止进程堆积、后端 serverCached 缓存、Gateway 轮询降频（15s→30s）、get_status_summary 改为直接读文件不走 CLI
- **R2 CDN 安装加速** — 新增 Cloudflare R2 预装归档下载（dl.qrj.ai），Windows 安装从 3-10 分钟降至 1-2 分钟
- **模型添加体验优化** — 快捷添加改为模型选择弹窗，用户可自主勾选需要的模型

## [0.9.2] - 2026-03-16

### 新功能 (Features)

- **SkillHub + ClawHub 双源技能管理** — Skills 页面新增已安装/搜索安装 Tab 切换，支持 SkillHub 和 ClawHub 双源下拉选择、搜索安装、卸载功能
- **SkillHub CLI 集成** — 新增 SkillHub 检测、安装、搜索、安装 Skill 的完整后端命令链（Rust + Web 双模式）
- **消息渠道多 Agent 绑定展示** — 已接入列表现在显示所有绑定的 Agent 标签，不再只显示第一个
- **消息渠道快速绑定 Agent** — 已接入平台点击"绑定新 Agent"弹出简化的 Agent 选择弹窗，无需重新填写凭证
- **消息渠道多账号支持（飞书）** — 后端 save_messaging_platform 支持 accountId 参数，可将不同飞书应用绑定到不同 Agent
- **NVM_SYMLINK 环境变量支持** — Windows 下 nvm 用户的 Node.js 路径检测更可靠

### 修复 (Fixes)

- **Skills JSON 解析修复** — extractCliJson 函数正确处理 CLI 输出中混入的 Node.js 警告信息
- **`--verbose` 日志污染** — 移除 openclaw skills 命令中多余的 --verbose 参数，避免输出被 npm 日志污染
- **SkillHub 搜索结果解析** — 修复实际 CLI 输出格式与预期不符导致的搜索结果为空
- **Windows cmd /c 兼容** — SkillHub/npx/ClawHub 命令在 Windows 上正确通过 cmd /c 调用
- **Cron delivery 参数格式** — 定时任务投递参数修复为正确的 mode+to+channel 格式
- **白屏安全网** — boot() 增加 try-catch 和 splash 超时检测，WebView2 加载失败时不再白屏

### 改进 (Improvements)

- **Git HTTPS 重写规则扩展** — 从 6 条扩展到 14 条，覆盖 GitHub/GitLab/Bitbucket 的所有 SSH/Git 协议变体
- **Agent 管理直接读 openclaw.json** — 不再通过 CLI 获取 Agent 列表，响应速度大幅提升
- **记忆文件直接读 openclaw.json** — Agent workspace 路径从配置文件直接解析，避免 CLI 调用阻塞
- **NSIS 中文语言选择器** — Windows 安装包默认中文，支持语言选择
- **WebView2 内嵌引导安装** — NSIS 安装包内嵌 WebView2 bootstrapper，离线环境也能安装
- **模型添加体验优化** — 模型页面快捷添加改为模型选择弹窗，用户可自主勾选需要的模型
- **助手系统提示词精简** — 移除冗余信息，聚焦技术支持核心能力

## [0.8.6] - 2026-03-13

### 修复 (Fixes)

- **切换汉化版 SSH 认证失败** — npm install 子进程现通过 `GIT_CONFIG_COUNT` 环境变量强制注入 HTTPS insteadOf 规则，确保即使全局 git config 未生效（Windows PATH 问题等），SSH→HTTPS 替换也能在 npm 子进程中工作
- **#58 定时任务触发错误** — 修复 `fetchJobs` 中 `id: j.name || j.id` 导致自定义名称的任务无法触发（感谢 @axdlee）
- **#63 systemd 部署找不到 OpenClaw** — 文档改用 `$(which node)` 动态路径 + `Environment=PATH` 确保 systemd 服务能找到 Node.js 和 OpenClaw CLI
- **#64 Skills 页面 JSON 解析错误** — `openclaw skills list --json` 输出混入 Node.js 警告时不再报错，新增 `extract_json` 提取有效 JSON 对象
- **CI rustfmt/clippy 跨平台警告** — 修复 `unused_imports`（BufRead/BufReader 移入 cfg block）、`needless_return`×3、`and_then→map`

### 改进 (Improvements)

- **错误诊断更精准** — SSH 错误诊断改用更严格的匹配（`permission denied`、`publickey`、`host key verification`），不再被 npm verbose 日志中的 `git@` 字样误触发
- **README 文档增强** — 新增「快速上手」4 步指南、Web 版部署指南（含 Nginx 配置示例）、消息渠道配置指南、FAQ 扩充 6 个常见问题

## [0.8.5] - 2026-03-13

### 修复 (Fixes)

- **Web 模式渠道配对报错** — 补全 `pairing_list_channel` / `pairing_approve_channel` 后端 handler，飞书/钉钉配对审批不再报"未实现的命令"
- **Web 模式插件状态报错** — 补全 `get_channel_plugin_status` / `install_channel_plugin` handler，QQ 机器人等插件保存不再 404
- **Web 模式初始设置缺失** — 补全 `check_git` / `auto_install_git` / `configure_git_https` / `guardian_status` / `invalidate_path_cache` handler，Web 部署全流程可用

### 改进 (Improvements)

- **Web 模式 handler 100% 覆盖** — dev-api.js 现已覆盖 tauri-api.js 中所有命令，Web 部署不再出现"未实现的命令"错误

## [0.8.4] - 2026-03-13

### 改进 (Improvements)

- **移除龙虾军团入口** — 精简产品功能，移除 Docker 集群管理页面及相关军事化主题 UI，聚焦"简单好用"的核心体验
- **前端瘦身** — 删除 3 个专用模块（docker.js / docker-tasking.js / pixel-roles.js），pages.css 减少约 700 行，tauri-api.js 清理 30 个未使用 API 方法

## [0.8.3] - 2026-03-12

### 修复 (Fixes)

- **默认安装改为原版** — 版本选择器默认选中「原版」（official），原版排在汉化版前面
- **CI Clippy 兼容** — Linux root 检测从 `unsafe libc::geteuid()` 改为 `std::env::var("USER")`，移除 libc 依赖

## [0.8.2] - 2026-03-12

### 修复 (Fixes)

- **接口地址不再强制拼接 /v1** — 火山引擎（/v3）等第三方 API 不再被错误追加 /v1，仅 Ollama（端口 11434）自动补全
- **OpenClaw 升级 SSH 失败** — 增加 `git://` 和 `git+ssh://` 协议重定向到 HTTPS，`--unset-all` + `--add` 确保 4 条规则全部生效
- **飞书插件安装失败** — 新增内置插件检测（`is_plugin_builtin`），已内置时自动跳过 npm install
- **飞书保存 ReferenceError** — 修复 `overlay is not defined`（应为 `modal`），修复表单收集不支持 `<select>` 字段
- **飞书插件版本持久化** — 切换官方/内置插件后重新打开弹窗不再丢失选择，自动检测已安装的插件版本
- **龙虾军团 Docker 检测报错** — 修复桌面版 Tauri 模式下返回 HTML 导致 JSON 解析失败，新增「需要 Web 部署模式」专属指引
- **聊天重复消息** — 新增 runId 去重机制，防止 Gateway 多次触发同一消息产生重复气泡
- **定时任务 RPC 参数** — `cron.remove` / `cron.run` / `cron.update` 参数从 `name` 修正为 `id`
- **消息渠道操作响应慢** — `save` / `toggle` / `remove` 的 Gateway 重载改为后台异步执行，API 立即返回
- **消息渠道 toggle 不刷新** — 扩展缓存失效范围至 `read_openclaw_config` + `read_platform_config`
- **Linux 非 root 用户 sudo** — `npm_command()` 自动检测 `euid != 0` 并加 `sudo`
- **Control UI 远程访问** — 动态使用浏览器域名/IP 替代硬编码 `127.0.0.1`，自动附带 Gateway auth token
- **npm 镜像源降级重试** — 淘宝源安装失败时自动切换到官方源重试
- **QQ 插件 native binding** — 检测到 OpenClaw CLI 原生依赖缺失时给出友好提示和修复命令
- **错误诊断增强** — exit 128 区分 SSH/Git 未安装；新增 native binding 检测

### 新功能 (Features)

- **关于页面公司信息** — 新增「关于我们」板块：武汉晴辰天下网络科技有限公司
- **模型预设共享模块** — 提取 `src/lib/model-presets.js`，消除 models.js 和 assistant.js 重复维护
- **飞书双插件支持** — 内置插件（聊天入口）或飞书官方插件（操作文档/日历/任务）可选
- **晴辰助手快捷选择** — 设置弹窗新增 OpenAI / DeepSeek / Ollama 等服务商一键填充按钮

### 改进 (Improvements)

- **官网下载链接动态化** — 从 `latest.json` 自动获取最新版本号，走 `claw.qt.cool/proxy/dl/` 国内代理
- **Linux 部署文档完善** — 升级指南增加 Gitee 镜像、sudo 权限说明、淘宝源降级说明
- **linux-deploy.sh** — Gitee clone fallback + sudo npm + 淘宝源 registry + 官方源降级

## [0.8.0] - 2026-03-12

### 新功能 (Features)

- **Ollama 本地模型兼容** — 自动规范化 Ollama baseUrl（追加 `/v1`），打开模型配置页时自动修复存量配置，解决 HTTP 404 问题
- **Git 自动检测与安装** — 初始化引导新增 Git 检测步骤，支持一键安装（Windows winget / macOS xcode-select / Linux apt/yum/dnf/pacman），安装失败提供分平台手动安装指引
- **Git SSH→HTTPS 自动配置** — 检测到 Git 已安装后自动配置 HTTPS 替代 SSH（3 条 insteadOf 规则），彻底解决国内用户 SSH 不通导致依赖安装失败的问题
- **Gitee 国内镜像** — 部署脚本、项目链接、贡献页面全面接入 Gitee 镜像（gitee.com/QtCodeCreators/clawpanel），国内用户无需翻墙
- **实时聊天会话重命名** — 双击会话名称可内联编辑，本地缓存不影响 Gateway 数据，顶部标题同步更新
- **刷新模型按钮** — 聊天页面模型选择器旁新增刷新按钮，手动刷新模型列表
- **本地图片渲染** — AI 发送的本地文件路径图片（如截图）在 Tauri 环境下通过 asset protocol 正确加载

### 修复 (Fixes)

- **环境检测实时生效** — 保存自定义 Node.js 路径后无需重启应用，PATH 缓存从 OnceLock 改为 RwLock 支持运行时刷新
- **Windows 自定义路径优先级** — 修复用户指定的 Node.js 路径被系统 PATH 覆盖的问题（自定义路径现在排最前）
- **模型加载超时兜底** — 读取模型配置增加 8 秒超时，不再无限停在"加载模型中..."
- **版本更新检测降级** — GitHub API 失败时自动降级到 Gitee API，检测失败显示"前往官网下载"按钮
- **重置会话确认框** — 点击重置按钮弹出确认对话框，防止误操作清空聊天记录

### 改进 (Improvements)

- **卡片式会话列表** — 会话列表从简单文本改为卡片式布局，显示 Agent 标签、消息数量、相对时间（如"3 分钟前"）
- **当前会话高亮** — 活跃会话改为 accent 色边框 + 加粗文字，辨识度大幅提升
- **聊天顶部栏防溢出** — 长标题自动截断显示省略号，操作区不被挤压
- **术语统一** — "智能体" 统一为 "Agent"（聊天/Agent 管理页面）
- **侧边栏重命名** — "AI 助手" 改为 "晴辰助手"
- **baseUrl 自动规范化** — 保存模型配置时自动清理尾部端点路径、追加 /v1，兼容用户粘贴完整 URL
- **官网下载引导** — 版本更新提示统一引导到 claw.qt.cool 官网
- **消息渠道 Agent 绑定** — 每个消息渠道配置弹窗新增 Agent 绑定选择器，通过 openclaw.json `bindings` 配置路由消息到指定 Agent
- **仪表盘概览重设计** — 从双列列表改为 3×2 卡片网格，含主模型/MCP/备份/Agent/配置，点击可跳转对应页面
- **仪表盘 Control UI 卡片** — 新增 OpenClaw 原生面板入口，点击在浏览器中打开 Gateway Web 界面
- **推荐弹窗优化** — 每天最多弹一次，不在聊天/助手页面弹出，弹窗加宽至 500px，4 个社群二维码 Grid 均匀排列
- **Gateway 横幅美化** — 渐变背景色 + 精简文案 + 启动失败显示错误详情和排查入口
- **公益站模型动态获取** — 移除硬编码模型 ID，始终从 API 实时拉取最新模型列表
- **定时任务 cron.jobs 自动修复** — 打开定时任务页面时自动检测并清除无效的 cron.jobs 配置字段

## [0.7.4] - 2026-03-11

### 新功能 (Features)

- **飞书/Lark 消息渠道** — 新增飞书企业消息集成，支持 App ID/Secret 配置、WebSocket 连接、凭证在线校验，附官方教程链接
- **openclaw.json 配置编辑器** — 服务管理页面新增配置文件直编功能，实时 JSON 语法校验，保存前自动备份，支持保存并重启 Gateway
- **定时任务页面** — 注册到侧边栏和路由，通过 Gateway WebSocket RPC 直接管理 cron 任务（创建/编辑/删除/启停/手动触发）
- **Docker 安装引导** — Docker 未连接时按操作系统（Windows/macOS/Linux）显示对应安装步骤和下载链接

### 修复 (Fixes)

- **#35 模型列表拉取崩溃** — 修复 Web 模式下 `_normalizeBaseUrl` 因 `this` 为 undefined 导致的 `Cannot read properties of undefined` 错误
- **消息渠道 Web 模式后端缺失** — 补全 `dev-api.js` 中全部消息渠道 API（list/read/save/remove/toggle/verify），修复 Web/Docker 模式下消息渠道页面 404
- **消息渠道弹窗溢出** — 接入步骤改为可折叠 `<details>`，modal 内容区域支持滚动
- **定时任务侧边栏图标缺失** — 补充 clock SVG 到侧边栏图标映射

### 改进 (Improvements)

- **定时任务按钮交互** — toggle/delete 按钮添加 loading 状态反馈
- **记忆模块切换动画** — Agent 切换和分类切换时显示骨架屏加载动画

## [0.7.3] - 2026-03-10

### 修复 (Fixes)

- **#32 Cookie 解析崩溃** — 修复 Authelia 等反代注入的非法 percent-encoding cookie 导致服务崩溃
- **#31 Gateway 重启丢失 CORS 配置** — `allowedOrigins` 改为合并模式，不再覆盖用户已有配置
- **#25 Windows 终端窗口闪烁** — 补全 Skills 安装/搜索、进程列表、端口检测的 `CREATE_NO_WINDOW` 标志
- **#33 模型测试误报失败** — 非认证 HTTP 错误（400/422）不再误报为失败，兼容阿里 Coding Plan 等提供商
- **#29 反代 WebSocket 协议不适配** — 自动检测 HTTPS 环境使用 `wss://`，龙虾军团面板链接协议自适应
- **#23 实时聊天会话列表自动收起** — 切换会话后侧边栏保持展开，提升多会话切换效率

### 改进 (Improvements)

- **模型测试响应格式兼容** — 新增 DashScope `output.text` 格式支持，reasoning 模型兼容增强

## [0.7.2] - 2026-03-10

### 新功能 (Features)

- **消息渠道管理** — 新增独立「消息渠道」页面，支持在面板内集中管理外部消息接入
- **内置 QQ 机器人接入** — 支持直接配置 QQ 机器人，并内置 QQBot 社区插件安装流程
- **Telegram / Discord 渠道配置** — 支持凭证填写、在线校验、保存后自动重载 Gateway 生效

### 改进 (Improvements)

- **版本号同步到 0.7.2** — 官网下载区、桌面端版本信息和构建配置统一升级到 0.7.2
- **渠道体验优化** — 本轮对外聚焦消息渠道能力，突出内置 QQ 机器人与统一接入体验

## [0.7.0] - 2026-03-08

### 新功能 (Features)

- **OpenClaw 版本管理** — 支持安装/升级/降级/切换版本，汉化版与原版自由选择，版本号从 npm registry 实时拉取
- **版本选择器弹窗** — 可视化选择目标版本，自动判断操作类型（安装/升级/降级/切换/重新安装）
- **Headless Web 服务器** — 新增 `npm run serve` 独立 Node.js 静态服务器，替代 `npx vite`，用于 Linux 无桌面部署
- **扩展工具管理** — Skills 页面全新设计，支持浏览、安装、卸载 MCP 工具
- **前端热更新基础设施** — Release 自动构建 web 包，支持 OTA 检查与回退

### 改进 (Improvements)

- **macOS Gatekeeper 提示优化** — 官网 + README 强调「先拖入应用程序」，新增 `~/Downloads` 路径备选命令
- **部署文档统一** — `linux-deploy.sh/md`、`docker-deploy.md`、`README.md` 全部改为 `npm run serve`
- **弹窗标题动态化** — 安装/升级/降级/卸载操作各自显示准确标题，关闭弹窗后自动刷新页面
- **跨平台兼容** — `serve.js` 路径分隔符使用 `path.sep`，确保 Windows/Linux/macOS 通用
- **AI 助手危险工具确认** — 执行系统命令等高风险操作前弹出二次确认

## [0.6.0] - 2026-03-07

### 新功能 (Features)

- **公益 AI 接口计划** — 内置免费 AI 接口（gpt.qt.cool），GPT-5 全系列模型一键接入，Token 费用由项目组承担
- **Agent 灵魂借尸还魂** — AI 助手可从 OpenClaw Agent 加载完整灵魂（SOUL / IDENTITY / USER / AGENTS / TOOLS），继承人格与记忆
- **知识库注入** — 自定义 Markdown 知识注入 AI 助手，对话时自动激活
- **AI 工具权限管控** — 工具调用权限三档可调（完整 / 受限 / 禁用），危险操作二次确认
- **全局 AI 浮动按钮** — 任意页面错误自动捕获，一键跳转 AI 助手分析诊断
- **一键部署脚本** — `deploy.sh` 支持 curl/wget 双模式，适配 Docker / WSL / Linux 环境

### 改进 (Improvements)

- **安装失败诊断增强** — Rust 后端收集 stderr 最后 15 行，JS 端延迟 150ms 确保完整日志捕获；新增 ENOENT(-4058)、权限、网络等详细诊断
- **UI 图标统一** — 全面替换 emoji 为 SVG 图标组件（assistant / chat-debug / about / services 等页面）
- **模型配置增强** — 公益接口 Banner + 一键添加全部模型，批量连通性测试
- **官网全面改版** — Hero 换为 AI 助手、Showcase 8 行 + Gallery 6 格重新编排、全部文案重写、新增活动板块和抖音社群
- **开发模式增强** — dev-api.js Mock API 大幅扩展，支持 AI 助手全流程调试

## [0.5.6] - 2026-03-06

### 安全修复 (Security)

- **dev-api.js 命令注入漏洞** — `search_log` 的 `query` 参数直接拼入 `grep` shell 命令，可注入任意系统命令。改为纯 JS 字符串匹配实现
- **dev-api.js 路径遍历漏洞** — `read_memory_file` / `write_memory_file` / `delete_memory_file` 未校验路径，可通过 `../` 读写任意文件。新增 `isUnsafePath()` 检查（与 Rust 端 `memory.rs` 对齐）
- **Gateway allowedOrigins 过于宽松** — `patch_gateway_origins()` 设置 `["*"]` 允许任何网页连接本地 Gateway WebSocket。收紧为仅允许 Tauri origin + `localhost:1420`

### 改进 (Improvements)

- **AI 助手审计日志** — `assistant_exec` / `assistant_read_file` / `assistant_write_file` 新增操作审计日志，记录到 `~/.openclaw/logs/assistant-audit.log`
- **connect frame 版本号** — `device.rs` 中 `userAgent` 和 `client.version` 从硬编码 `1.0.0` 改为编译时读取 `Cargo.toml` 版本
- **enhanced_path() 性能优化** — 使用 `OnceLock` 缓存结果，避免每次调用都扫描文件系统

## [0.5.5] - 2026-03-06

### 修复 (Bug Fixes)

- **Linux Gateway 服务管理不可用 (#7, #10)** — 新增 `linuxCheckGateway()`（ss → lsof → /proc/net/tcp 三级 fallback）、`linuxStartGateway()`（detached 子进程）、`linuxStopGateway()`（SIGTERM），所有 handler 分支加入 Linux 支持；修复 `reload_gateway` / `restart_gateway` 错误执行 `systemctl restart clawpanel`（重启面板而非 Gateway）的问题
- **systemd 环境下 OpenClaw CLI 检测失败 (#8)** — 新增 `findOpenclawBin()` 路径扫描，覆盖 nvm / volta / nodenv / fnm / `/usr/local/lib/nodejs` 等所有常见路径，替代仅依赖 `which` 的方式
- **非 root 用户无法部署 ClawPanel (#9)** — `linux-deploy.sh` 支持非 root 安装：普通用户安装到 `$HOME/.local/share/clawpanel`，使用 user-level systemd 服务 + `loginctl enable-linger`；系统包安装通过 `run_pkg_cmd()` 按需 sudo

## [0.4.8] - 2026-03-06

### 修复 (Bug Fixes)

- **macOS Gateway 启动失败 (Bootstrap failed: 5)** — plist 二进制路径过期（如 nvm/fnm 切版本后）导致 `launchctl bootstrap` 报 I/O error。新增回退机制：launchctl 失败时自动改用 CLI 直接启动 Gateway，启动和重启均适用

## [0.4.7] - 2026-03-06

### 修复 (Bug Fixes)

- **fnm 用户 Node.js 检测失败** — 移除错误的 `~/.fnm/current/bin`，改为扫描 `$FNM_DIR/node-versions/*/installation/bin`（macOS/Linux）和 `%FNM_DIR%\node-versions\*\installation`（Windows），兼容 fnm 默认 XDG 路径
- **Release Notes 生成失败** — 中文 commit message 不以 `feat:/fix:` 开头时 `grep` 返回 exit 1，GitHub Actions `pipefail` 导致脚本终止，已用 `|| true` 修复

## [0.4.6] - 2026-03-06

### 修复 (Bug Fixes)

- **严重：mode 字段位置错误导致 Gateway 无法启动** — `"mode": "local"` 被错误写入 `openclaw.json` 顶层，OpenClaw 报 `Unrecognized key: "mode"`。正确位置是 `gateway.mode`，已修复所有写入点（init_openclaw_config、dashboard 自愈、setup 安装流程）
- **旧版配置自动修复** — 仪表盘加载时自动删除错误的顶层 `mode` 字段并移入 `gateway.mode`，已安装用户无需手动编辑

## [0.4.5] - 2026-03-06

### 修复 (Bug Fixes)

- **nvm 用户 Node.js/CLI 检测失败** — `enhanced_path()` 新增扫描 `~/.nvm/versions/node/*/bin`（macOS/Linux）和 `%APPDATA%\nvm\*`（Windows），从 Finder/桌面启动也能找到 nvm 安装的 Node.js
- **Tauri v2 参数名不匹配** — `check_node_at_path`、`save_custom_node_path` 及所有 memory 函数的 snake_case 参数改为 camelCase，修复手动指定 Node.js 路径报 `missing required key` 的问题
- **Windows OpenClaw CLI 检测遗漏** — `is_cli_installed()` 仅检查 `%APPDATA%\npm\openclaw.cmd`，新增通过 PATH 运行 `openclaw --version` 兜底，兼容 nvm、自定义 prefix 等安装方式
- **Agent 管理/记忆文件页面晦涩错误** — `No such file or directory (os error 2)` 替换为中文提示「OpenClaw CLI 未找到，请确认已安装并重启 ClawPanel」

### 新增 (Features)

- **初始设置自动创建配置文件** — 检测到 CLI 已装但 `openclaw.json` 不存在时，自动创建含合理默认值的配置文件（mode:local, tools:full 等），无需手动执行 `openclaw configure`
- **一键初始化配置按钮** — 自动创建失败时，设置页第三步显示「一键初始化配置」按钮作为手动备选
- **ClawPanel Web 版部署文档** — 新增 Linux 一键部署脚本和 Docker 部署指南，官网增加文档中心

## [0.4.4] - 2026-03-06

### 新增 (Features)

- **Agent 工具权限配置** — Gateway 配置页新增「工具权限」区域，可选完整权限（full）/ 受限模式（limited）/ 禁用工具（none），以及会话可见性设置
- **工具权限自愈** — 安装/升级后自动设置 `tools.profile: "full"` + `tools.sessions.visibility: "all"`，老用户打开面板也会自动补全，避免 OpenClaw 2026.3.2 新版默认关闭工具导致不好用

## [0.4.3] - 2026-03-06

### 修复 (Bug Fixes)

- **Gateway 首次安装后无法启动** — 安装流程未设置 `mode: "local"`，导致 Gateway 不知道以什么模式运行。现在安装完成后自动写入，仪表盘加载时也会自愈补全

## [0.4.2] - 2026-03-06

### 修复 (Bug Fixes)
- **Windows Node.js 检测失败** — `enhanced_path()` 扩展为跨平台，Windows 上自动扫描 Program Files、LOCALAPPDATA、APPDATA、常见盘符（C/D/E/F）下的 Node.js 安装路径
- **Git SSH 导致安装失败 (exit 128)** — npm 依赖使用 SSH 协议拉取 GitHub 仓库，用户没配 SSH Key 时报 `Permission denied (publickey)`。安装前自动执行 `git config --global url.https://...insteadOf ssh://...` 切换为 HTTPS
- **npm 安装失败无引导** — 安装/升级 OpenClaw 失败时仅显示"安装失败"，现在自动诊断错误类型（Git SSH 权限 / Git 未安装 / EPERM 文件占用 / MODULE_NOT_FOUND 安装不完整 / ENOENT / 权限不足 / 网络错误 / 缓存损坏）并给出具体修复命令

### 优化 (Improvements)

- **Node.js 路径扫描** — 检测不到 Node.js 时提供「自动扫描」按钮，扫描 C/D/E/F/G 盘常见安装路径（含 AI 工具目录），找到后一键选用
- **手动指定 Node.js 路径** — 用户可手动输入 Node.js 安装目录，检测通过后自动保存到 `~/.openclaw/clawpanel.json`，后续所有命令自动使用
- **跨平台检测引导** — 安装引导页 Node.js 检测失败时，macOS 提示从终端启动，Windows 提示重启 ClawPanel 或检查 PATH
- **错误诊断模块** — 新增 `error-diagnosis.js` 共享模块，安装引导页和服务管理页共用错误诊断逻辑
- **README 常见问题** — 新增 7 个常见安装问题的排查指南

## [0.4.1] - 2026-03-06

### 修复 (Bug Fixes)

- **macOS Node.js 检测失败** — Tauri 从 Finder 启动时 PATH 不含 `/usr/local/bin`、`/opt/homebrew/bin` 等常见路径，导致 `check_node`、`npm_command`、`openclaw_command` 找不到命令。新增 `enhanced_path()` 补充 nvm/volta/nodenv/fnm/n 等 Node.js 管理器路径

## [0.4.0] - 2026-03-05

### 新增 (Features)

- **Gateway 进程守护** — 检测到 Gateway 意外停止时自动重启（最多 3 次，60s 冷却期），用户主动停止不干预
- **守护恢复横幅** — 连续重启失败后顶部弹出恢复选项（重试启动 / 从备份恢复 / 服务管理 / 查看日志）
- **配置文件自愈** — 读取 `openclaw.json` 时自动剥离 UTF-8 BOM，JSON 损坏时自动从 `.bak` 恢复
- **双配置同步** — 保存模型配置时自动同步到 agent 运行时注册表（`models.json`），包括新增/修改/删除 provider 和 model
- **流式输出安全超时** — 90 秒无新数据自动结束流式输出，防止 UI 卡死
- **聊天响应耗时显示** — AI 回复时间戳后显示响应耗时（如 `20:09 · 1.7s`）
- **跨天时间显示** — 非当天消息显示日期（如 `03-04 20:09`），当天仅显示时间
- **仪表盘自动刷新** — Gateway 状态变化时自动刷新仪表盘数据，无需手动刷新

### 修复 (Bug Fixes)

- **401 无效令牌** — 修复 `models.json`（agent 运行时注册表）与 `openclaw.json` provider 配置不同步导致的认证失败
- **删除模型后 Gateway 崩溃** — 删除模型/渠道后自动切换主模型到第一个可用模型，同步清理 `models.json` 中已删除的 provider 和 model
- **WebSocket 连接被拒** — `allowedOrigins` 改为通配符 `["*"]`，兼容所有 Tauri 运行模式
- **模型测试触发 Gateway 重启** — 测试结果保存改用 `saveConfigOnly`，不再触发不必要的重启
- **主模型配置不生效** — `applyDefaultModel` 同步更新到各 agent 的模型覆盖配置，防止 agent 级别旧值覆盖全局默认
- **WS 代理报错刷屏** — Vite 配置静默处理 Gateway 不可达时的 proxy error
- **历史图片丢失提示** — 刷新后 Gateway 不返回图片原始数据时显示友好提示

### 优化 (Improvements)

- **拖拽排序重写** — 模型拖拽排序改用 Pointer Events 实现，兼容 Tauri WebView2/WKWebView
- **用户消息附件保存** — 发送的图片附件保存到本地缓存，支持页面内恢复

## [0.3.0] - 2026-03-04

### 新增 (Features)

- **Gateway 认证模式切换** — 支持 Token / 密码双认证模式，卡片式选项可视化配置
- **GitHub Pages 全面重写** — 零 CDN 依赖（移除 Tailwind/Google Fonts），纯 CSS 实现，页面秒开
- **社区交流板块** — 新增 QQ 群 / 微信群二维码、Discord / 元宝派 / GitHub Discussions 等社区入口
- **10 张演示截图** — GitHub Pages 与 README 同步集成功能截图，含交互式灯箱与 hover 特效
- **高级视觉特效** — 粒子上升动画、旋转彩虹边框、鼠标追光、浮动光球、透视英雄图等纯 CSS/JS 实现

### 修复 (Bug Fixes)

- **origin not allowed 自动修复** — WebSocket 握手阶段的 origin 拒绝错误现在正确触发自动配对修复
- **防止自动配对死循环** — 限制自动配对最多尝试 1 次，失败后显示连接遮罩而非无限重连
- **诊断页修复按钮反馈** — 「一键修复配对」按钮增加 loading 状态和日志面板自动滚动
- **Logo 加载修复** — GitHub Pages 使用本地 logo.png，修复私有仓库无法加载的问题
- **亮色模式按钮文字** — 修复 glow-border 按钮在亮色模式下文字不可见的问题

### 优化 (Improvements)

- **README 社区板块** — 新增二维码展示 + 6 个社区渠道链接表格
- **WebSocket 监听器清理** — connectGateway 调用前清理已有事件监听，防止重复绑定

## [0.2.1] - 2026-03-04

### 新增 (Features)

- **聊天图片完整支持** — AI 响应中的图片现在可以正确提取和渲染（支持 Anthropic / OpenAI / 直接格式）
- **图片灯箱查看** — 点击聊天中的图片可全屏查看，支持 ESC 关闭
- **会话列表折叠** — 聊天页面侧边栏支持点击 ≡ 按钮收起/展开，带平滑过渡动画
- **参与贡献入口** — 关于页面新增「参与贡献」区块，包含提交 Issue、提交 PR、贡献指南等快捷链接

### 修复 (Bug Fixes)

- **聊天历史图片丢失** — `extractContent` / `dedupeHistory` / `loadHistory` 现在正确提取和渲染历史消息中的图片
- **流式响应图片丢失** — delta / final 事件处理新增 `_currentAiImages` 收集，`resetStreamState` 正确清理
- **私有仓库更新检测** — 检查更新失败时区分 403/404（仓库未公开）和其他错误，显示友好提示

### 优化 (Improvements)

- **开源文档完善** — 新增 `SECURITY.md` 安全政策，同步版本号至 0.2.x，补充项目元数据
- **仪表盘分波渲染** — 9 个 API 改为三波渐进加载，关键数据先显示，消除白屏等待

## [0.2.0] - 2026-03-04

### 新增 (Features)

- **ClawPanel 自动更新检测** — 关于页面自动检查 ClawPanel 最新版本，显示更新链接
- **系统诊断页面** — 全面检测系统状态（服务、WebSocket、Node.js、设备密钥），一键修复配对
- **聊天连接引导遮罩** — WebSocket 连接失败时显示友好引导界面，提供「修复并重连」按钮，替代原始错误消息
- **图片上传与粘贴** — 聊天页面支持附件上传和 Ctrl+V 粘贴图片，支持多模态对话

### 修复 (Bug Fixes)

- **首次启动 origin 拒绝** — 修复 `autoPairDevice` 在设备密钥不存在时提前退出、未写入 `allowedOrigins` 的问题
- **Gateway 配置不生效** — 写入 `allowedOrigins` 后自动 `reloadGateway`，确保新配置立即生效
- **WebSocket 自动修复** — `_autoPairAndReconnect` 补充 `reloadGateway` 调用，修复自动配对后仍被拒绝的问题
- **wsClient.close 不存在** — 修正为 `wsClient.disconnect()`
- **远程模型缺少视觉支持** — 添加模型时 `input` 改为 `['text', 'image']`
- **连接级错误拦截** — 拦截 `origin not allowed`、`NOT_PAIRED` 等连接级错误，不再作为聊天消息显示

### 优化 (Improvements)

- **仪表盘分波渲染** — 9 个 API 请求改为三波渐进加载，关键数据先显示，消除打开时的白屏等待
- **全页面骨架屏** — 所有页面添加 loading-placeholder 骨架占位，提升加载体验
- **页面清理函数** — models.js 添加 `cleanup()` 清理定时器和中止控制器，防止内存泄漏
- **发布工作流增强** — release.yml 生成分类更新日志、可点击下载链接、首次使用指南

## [0.1.0] - 2026-03-01

首个公开发布版本，包含 OpenClaw 管理面板的全部核心功能。

### 新增 (Features)

- **仪表盘** — 6 张状态卡片（Gateway、版本、Agent 舰队、模型池、隧道、基础服务）+ 系统概览面板 + 最近日志 + 快捷操作
- **服务管理** — OpenClaw 服务启停控制、版本检测与一键升级（支持官方/汉化源切换）、Gateway 安装/卸载、npm 源配置（淘宝/官方/华为云）、配置备份管理（创建/恢复/删除）
- **模型配置** — 多服务商管理（支持 OpenAI/Anthropic/DeepSeek/Google 预设）、模型增删改查、主模型与 Fallback 选择、批量连通性测试与延迟检测、拖拽排序、自动保存 + 撤销栈（最多 20 步）
- **网关配置** — 端口配置、运行模式（本地/云端）、访问权限（本机/局域网）、认证 Token、Tailscale 组网选项，保存后自动重载 Gateway
- **Agent 管理** — Agent 增删改查、身份编辑（名称/Emoji）、模型配置、工作区管理、Agent 备份
- **聊天** — 流式响应、Markdown 渲染、会话管理、Agent 选择、快捷指令、WebSocket 连接
- **日志查看** — 多日志源（Gateway/守护进程/审计日志）实时查看、关键词搜索、自动滚动
- **记忆管理** — 记忆文件查看/编辑、分类管理（工作记忆/归档/核心文件）、ZIP 导出、Agent 切换
- **扩展工具** — cftunnel 内网穿透隧道管理（启停/日志/路由查看）、ClawApp 守护进程状态监控、一键安装
- **关于页面** — 版本信息、社群二维码（QQ/微信）、相关项目链接、一键升级入口
- **主题切换** — 暗色/亮色主题，CSS Variables 驱动
- **自定义 Modal** — 全局替换浏览器原生弹窗（alert/confirm/prompt），兼容 Tauri WebView
- **CI/CD** — GitHub Actions 持续集成 + 全平台发布构建（macOS ARM64/Intel、Windows x64、Linux x64）
- **手动发布** — 支持 workflow_dispatch 手动触发构建，填入版本号即可一键发布

### 优化 (Improvements)

- **全局异步加载** — 所有页面 render() 非阻塞返回 DOM，数据在后台异步加载，消除页面切换卡顿
- **路由模块缓存** — 已加载的页面模块缓存复用，二次切换跳过动态 import
- **Tauri API 预加载** — invoke 模块启动时预加载，避免每次 API 调用的动态 import 开销
- **页面过渡动画** — 进入动画（220ms 上滑淡入）+ 退出动画（100ms 淡出），丝滑切换体验
- **Windows 兼容** — Rust 后端通过 `#[cfg(target_os)]` 条件编译支持 Windows 平台（服务管理、版本检测、扩展工具等）
- **Setup 引导模式** — 未安装 OpenClaw 时自动进入引导页面，安装完成后切换到正常模式

### 技术亮点

- 零框架依赖：纯 Vanilla JS，无 React/Vue 等框架
- Tauri v2 + Rust 后端，原生性能
- 玻璃拟态暗色主题，现代化 UI
- 全中文界面与代码注释
- 跨平台支持：macOS (ARM64/Intel) + Windows + Linux
