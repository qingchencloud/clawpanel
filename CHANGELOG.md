# 更新日志

本项目的所有重要变更都将记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.16.0] - 2026-05-16

> 自 v0.15.3 起累计合入约 50+ 提交。本节补全此前更新日志未写明的功能与修复摘要。

### 新功能 (Features)

#### OpenClaw

- **OpenClaw 2026.5.12 + 握手协议 v4** — 连接帧 `maxProtocol` 扩展到 4，兼容 5.12+ 内核增量 chat delta（含 `replace` 语义）；推荐目标升至 `2026.5.12` / `2026.5.12-zh.2`
- **Gateway 握手协议版本可见化** — 服务页与聊天调试页新增 `Proto v3/v4` 徽标；悬停说明与设备签名 payload 的 `v3|` 前缀无关
- **系统推送通知 (`push.web.*`)** — 面板关闭后仍可收到 Gateway 推送的系统通知（需浏览器/系统权限）
- **`config.schema` 写入校验** — 通过 RPC 校验配置写入，降低误改坏 `openclaw.json` 的风险
- **导入客户端模型配置** — 扫描本机 Codex、Claude Code、Gemini CLI 与环境变量，向导式导入服务商/模型（不读取或复制 OAuth Token；OAuth 项仅作引导）

#### Hermes Agent

- **Profiles 管理** — 多工作区 Profile 的创建/切换/重命名，Dashboard API 通用代理
- **多 Gateway 看板** — 同时运行多个 profile 的 Gateway 实例
- **群聊** — 多 Agent 并行响应同一会话消息
- **文件管理器** — 在 `~/.hermes` 子树内浏览与编辑文件
- **Kanban 看板** — 任务看板视图
- **OAuth 登录** — 支持 PKCE / device_code / external 三种流程
- **多模态聊天** — 附件、拖拽与粘贴图片（base64）
- **Sessions 导出** — 经 Dashboard `/api/sessions/{id}/messages` 导出会话
- **流式恢复** — 断线/刷新后恢复进行中的流式输出
- **TTS + Dashboard Token** — 朗读与 Dashboard session token 自动注入
- **lazy_deps 预处理** — 安装 IM 相关可选依赖，避免首启 Gateway 长时间卡顿后崩溃
- **`hermes_read_config_full`** — 解析 Gateway 全量配置字段，解锁 14+ 高价值配置项
- **Approval Flow + Stop 真中断** — 工具审批流与可中断的运行
- **`/v1/capabilities` 暴露** — `hermes_capabilities` Tauri/Web 命令
- **就绪横幅** — Hermes 未安装或 Gateway 未启动时聊天页展示引导
- **安装网络诊断 + Git 镜像** — 安装失败时给出网络诊断与可选镜像
- **Hermes 消息渠道页（占位）** — `/h/channels` 路由已注册，UI 为 Phase 2「即将推出」，侧栏入口暂未开放

#### 面板与多引擎

- **Monolith 引擎选择屏** — 首次启动全屏对角线布局，可选 OpenClaw / Hermes / 双引擎 / 心甜宣传入口 / 稍后配置
- **心甜 Claw 引擎入口** — 产品宣传落地页（非本地 Gateway 引擎）
- **术语表 (`/glossary`)** — 侧边栏入口，解释 Gateway、Profile、渠道等术语

### 改进 (Improvements)

- **小白 UX 全面改造** — `humanizeError`、致命操作 `showConfirm`、空状态、Toast 行动按钮、配置页 ⓘ 术语提示
- **晴辰助手按引擎分发** — Hermes 模式下 system prompt 覆盖双进程、Profile、lazy_deps、`~/.hermes` 路径与排障清单，不再混入 `openclaw` CLI
- **Hermes Profile 页自动拉起 Dashboard** — 进入即 probe/启动 9119，避免裸 `10061` 网络错误
- **Hermes 视觉统一** — emoji 换 SVG 图标；多页 header 标题与操作按钮横向对齐
- **Hermes 侧边栏补全** — 群聊、文件管理等入口与图标
- **隐藏桌面端 Docker 管理** — 仅 Web 部署保留多实例 Docker 面板
- **模型 Fallback「清空全部」** — 一键清空整条备选链
- **仪表盘启动性能** — 减少骨架屏死锁、加快首屏渲染
- **目录结构优化** — 代码组织调整，便于维护
- **Qwen Cloud 命名** — Hermes Provider「阿里通义」与上游「Qwen Cloud」对齐

### 修复 (Fixes)

- **Windows Gateway 终端可见** — `cmd /c start` 独立控制台；停止时用 netstat 跟踪 PID
- **Fallback 链不再自动塞满** — 避免一次保存膨胀到 17+ 项；空链合法
- **无效主模型规范化** — 修复配置中指向不存在模型时的异常表现
- **批量模型测试误触发 Gateway 重启** — 批量连通性测试不再错误排队重启
- **Hermes Gateway 路由与依赖** — 修复消息发送依赖、Provider 路由与启动稳定性；优先 `/v1/runs` 复用 `session_id`
- **Web 模式事件订阅** — 统一 Tauri 事件 helper，消除 `transformCallback` 噪音
- **v3 握手失败提示** — 旧内核不支持握手时给出更友好文案
- **助手 OpenClaw 上下文路径** — 规范化助手读取的配置路径
- **可选依赖页安装提示** — 保留 Rust 原始错误文案，修复 `[object Object]` 显示
- **复查修复** — 双 listener、重复 stub、定时器泄漏、漏网中文、chat 语法隐患等
- **用户报告关键 Bug** — 一次性修复 5 项高优先级问题；会话列表增加区分度避免误判为 mock
- **CI 三平台恢复绿灯** — `scan_json_client_file` 等 clippy 局部豁免

### 测试与验证 (Testing)

- **发布前检查** — npm 前端构建、Rust fmt / check / clippy 三平台 CI 全绿（run 25955001087）
- **前端单元测试** — `node --test tests/*.test.js` 45/45 通过（含 `KERNEL_TARGET` 2026.5.12 断言）
- **Playwright 回归（发布流程内）** — Docker 桌面隐藏/Web 保留、lazy-deps 提示、Hermes header 布局、协议徽标等（用例在内部回归流程，未入库）

## [0.15.3] - 2026-05-13

### 修复 (Fixes)

- **退出/关机阶段不再启动外部清理进程** — 移除应用退出事件中启动 `taskkill.exe` 的兜底逻辑，避免 Windows 关机清理阶段新进程初始化失败导致 `0xc0000142` 弹窗

## [0.15.2] - 2026-05-13

### 修复 (Fixes)

- **退出时不再通过 cmd.exe 中转调用 taskkill** — 应用退出/系统关机时直接调用 `taskkill.exe` 关闭 Gateway 终端窗口，避免关机阶段 `cmd.exe` 初始化 DLL 失败导致系统事件日志报 `0xc0000142` 错误

## [0.15.1] - 2026-05-10

### 新功能 (Features)

- **首次引擎选择页** — 新增启动选择流程，支持选择 OpenClaw、Hermes Agent、双引擎或稍后配置，避免首次启动直接进入不匹配的安装向导
- **Hermes Agent Provider 预设增强** — 扩展 Provider 注册表与配置合并能力，前端、Web 后端和 Tauri 后端保持一致

### 改进 (Improvements)

- **Hermes Agent 流式对话兼容层** — 优先使用新的流式响应通道，失败时自动回退，并保持现有前端事件格式不变
- **Hermes Dashboard 生命周期管理** — 状态检测和停止操作优先使用 Hermes Agent 原生能力，失败后再回退到 ClawPanel 记录的进程信息，降低误报和误杀风险
- **Hermes Agent 安装体验** — 安装、升级和依赖补齐流程增加日志清理，避免用户界面暴露底层安装细节
- **多引擎初始化体验** — 引擎选择状态会持久化，切换引擎时清理旧请求缓存，减少跨引擎页面状态串扰
- **推荐内核版本策略** — 推荐版本更新到 `2026.5.7` 与 `2026.5.7-zh.1`

### 修复 (Fixes)

- **Hermes Dashboard 依赖提示** — 缺少 Web 依赖时改为引导使用内置安装按钮，减少手动命令操作
- **Hermes Agent 页面信息边界** — 清理 Dashboard、Setup、Chat、Skills、Memory、Logs、Cron、Extensions 等页面中的非必要实现细节展示
- **助手内置技能提示** — Hermes Agent 安装与升级建议改为使用 ClawPanel 内置向导，避免暴露底层安装命令

### 测试与验证 (Testing)

- **发布前检查** — 已通过 JS 语法检查、Rust 格式检查、Rust 编译检查和前端生产构建

## [0.15.0] - 2026-05-08

### 新功能 (Features)

- **内核版本兼容层** — 新增 `kernel.js` / `feature-catalog.js` / `api-compat.js`，统一管理 OpenClaw/Hermes 内核版本、特性门控、最低版本地板和新旧 RPC 返回结构兼容
- **内核升级提示** — 侧边栏新增可升级提示卡，低版本内核可直接触发一键升级流程；低于硬地板版本时显示阻断式引导，避免旧内核继续进入不兼容页面
- **CLI 冲突检测与隔离** — 新增 PATH 中外部 OpenClaw CLI 扫描、隔离、恢复能力，支持识别 Cherry Studio / Cursor / npm 全局安装等残留来源，降低错绑旧 CLI 的风险
- **Hermes 实时聊天桥接增强** — Web 模式补齐 Hermes Gateway `/v1/runs` 流式转发、API Key 注入、取消与错误事件处理，使浏览器模式与桌面模式聊天链路保持一致

### 改进 (Improvements)

- **OpenClaw 2026.5.6 适配** — 推荐版本更新到官方 `2026.5.6` 与汉化版 `2026.5.6-zh.1`，特性目录覆盖 sessions 分页、模型探测、memory deep status、doctor 修复、渠道进度等 5.x 能力
- **多版本内核兼容 UX** — Dashboard、服务页、Agents、Models、侧边栏和 WebSocket 连接流程统一接入内核快照，老内核自动降级，新内核显示更丰富状态
- **Gateway 重启体验** — 模型保存后先探测 Gateway 是否运行，运行中才防抖排队重启；未运行时只提示配置已保存，避免无意义 doctor/restart 卡顿
- **Hermes 安装依赖补齐** — `uv tool install` 统一追加 `croniter`，并默认安装 `hermes-agent[web]`，减少定时任务和 Web 面板运行时缺依赖
- **MiniMax 预设补全** — MiniMax 服务商预设恢复 OpenAI-compatible 入口，并补齐 M2.7/M2.5 及 highspeed 模型快捷项
- **热更新兼容底座** — 本次版本包含新增 Tauri 命令，热更新清单最低兼容版本提升到 `0.15.0`，避免旧桌面端加载不兼容前端

### 修复 (Fixes)

- **Hermes Gateway 本机自动拉起** — 自定义 Gateway URL 为 `127.0.0.1`、`localhost`、`::1` 等 loopback 地址时不再误判为远程 Gateway，桌面端和 Web 模式都会自动启动本机 Gateway
- **Hermes `/v1/runs` 连接失败诊断** — 启动 run 前自动确保本机 Gateway ready，请求失败时附带健康检查和日志尾部，便于定位 10061/连接拒绝等问题
- **Standalone 版本显示未知** — About 页和仪表盘优先读取 standalone 安装目录的 `VERSION` / `package.json`，正确识别官方版或汉化版，不再把一键安装包显示为未知版本或误判来源
- **仪表盘版本缓存自愈** — 检测到空版本、unknown 来源或不完整版本信息时自动清理 `get_version_info` 缓存并重新拉取，避免旧缓存长期显示未知
- **版本检测不再被运行态拖垮** — `openclaw status --json` 后移为 fallback 并增加短超时，避免 Gateway 未运行时拖慢 About 页和仪表盘
- **服务配置错误引导** — 启停服务遇到配置 schema 错误时弹出 `doctor --fix` 一键修复入口，而不是只显示技术错误 toast

### 测试与验证 (Testing)

- **本地 CI 链路补齐** — 新增/修复 kernel、Docker tasking、Gateway guardian policy、模型预设测试；本地通过 45 个 JS 测试和 16 个 Rust 单元测试
- **发布前检查增强** — Release 工作流文档增加人工确认门禁，要求版本号、提交、tag、push 前完成 Web/桌面/Hermes/OpenClaw 回归确认

## [0.14.0] - 2026-04-25

### 新功能 (Features)

- **心甜Claw 引擎入口** — 新增第三个引擎模式「心甜Claw」，提供产品介绍页、官网/下载入口、专属视觉样式与多语言文案，logo 图标资源同步更新
- **Hermes 服务商注册表** — 新增 22 个 Hermes Provider 注册信息（17 个 api_key、3 个 OAuth、1 个外部进程、1 个聚合占位），支持 API Key、OAuth、外部进程与聚合服务商，安装向导和仪表盘可动态加载服务商与模型配置
- **Hermes .env 高级编辑** — 新增非托管环境变量编辑页 `/h/env`，三个新 Tauri 命令（`hermes_env_read_unmanaged` / `hermes_env_set` / `hermes_env_delete`）严格拒绝触碰 ClawPanel 托管的 Provider 密钥，敏感值在 UI 中自动遮罩
- **Hermes 会话与用量分析增强** — 新增轻量会话摘要、按 Profile 浏览历史会话、Usage Analytics 后端统计与扩展主题页数据入口
- **Hermes Dashboard 自动拉起** — 仪表盘"打开 Hermes 面板"和扩展页相关链接点击时自动探活 9119 端口，未运行则后台 spawn 进程并轮询启动结果，附带依赖未装与 Windows 不兼容（POSIX-only 模块）的专属错误模态
- **Hermes Skills 工具集面板** — Skills 页顶部新增 Toolsets 区，解析 `hermes tools list` 输出，按平台显示 enabled/disabled 状态与刷新按钮，可视化 20 个内置工具集的启用情况
- **Hermes Agent 黑金特色区（官网）** — `docs/index.html` 新增 Hermes Agent 编辑风专题展示（4 张高清截图 h00-h03 + 4 个能力点矩阵），新增「Hermes Agent 图文指南」文档卡片与 `docs/hermes-agent.md` 视觉指南
- **Boot Manifest 启动页改版** — `index.html` 启动页升级为 IDE/Linear/Vercel 风格 manifest 列表，4 步骤错峰淡入动画，支持 zh/en 双语切换并通过 `clawpanel-lang-change` 与应用 i18n 同步
- **官网 Markdown 阅读器图片放大** — 文档读阅模态中的图片支持点击全屏 lightbox 浏览
- **Hermes Memory 概览卡** — Memory 页头部新增编辑风 overview 卡（kicker + 大标题 + 描述 + 4 块统计：记忆文件数 / 已填写 / 总词数 / 最近更新）

### 改进 (Improvements)

- **Hermes 仪表盘本地化** — 将 Gateway、Provider、连接目标、快捷操作、CLI 表头、保存/探测提示等硬编码文案接入语言包
- **Hermes 扩展与主题本地化** — 扩展页标题、说明、按钮、插件扫描与主题保存提示统一接入多语言文案
- **Hermes 记忆编辑体验** — 记忆文件编辑改为大尺寸模态框，避免长内容被卡片区域限制
- **日志下载反馈** — 桌面端日志下载保存到系统 `Downloads/ClawPanel` 并显示真实路径；Web 端继续浏览器下载并明确提示查看默认下载目录
- **侧边栏导航补全** — 补齐 Hermes 会话浏览、扩展与主题等导航项图标与文案
- **模型备选管理 UI** — 合并 PR #232，将主/备模型面板改为可折叠瀑布流编辑器，支持候选池分组、拖拽排序和备选提升为主模型
- **模型加载失败 UX 重做** — `src/pages/models.js` 配置加载失败不再是一行红字；改为带图标的错误卡 + 友好提示 + 可折叠技术详情（含 stack）+ 重试按钮，错误信息全 HTML 转义
- **`.page` 布局优化** — 水平 padding 改用 `clamp(--space-xl, 3vw, --space-3xl)`，宽屏不再贴边；新增 `.page-narrow` 类（`max-width: 960px`）供长文本/表单页保持可读性
- **Memory 单列断点提早** — 1100px 起切单列，避免 1024px viewport 下 copy 列被压到 230px、标题被迫 4 行
- **Web 模式跳过热更新检查** — Web 浏览器每次刷新自动拿最新前端，前端热更新无意义；跳过 `check_frontend_update` 调用，减少 dev console 404 噪音

### 修复 (Fixes)

- **Hermes Gateway 启动自修复** — 启动前自动检查并修复 `platforms.api_server.enabled`，避免升级或手动编辑配置后 Gateway 缺失 `/v1/runs` 能力，含 7 个 unit test 覆盖各种 YAML 形态；变更前自动写时间戳备份 `config.yaml.bak-<epoch>`，前端订阅 `hermes-config-patched` 事件并 toast 提示
- **Memory 页 Overview 穿模** — `.hermes-memory-page` 上一代旧设计遗留的 `display: flex; height: 100%` 把 5 个子项压在 899px viewport 里互相挤压，导致 overview 被压到 110px（自然 227px），标题溢出穿过半透明 stat 卡片；移除 flex 列约束，改回自然块级流，让外层 `#content` 滚动
- **Skills 页 hero/toolsets 被压缩** — 新加的 Toolsets 区与 hero 在 flex 列里争抢空间，hero 自然 240px 被压到 165px；hero + toolsets 锁 `flex-shrink: 0`，只让两栏 layout 区伸缩
- **Web 模式 Skills 页 ReferenceError** — `dev-api.js` 的 `hermes_skills_list` 调用了未定义的 `readHermesDisabledSkills`，导致 Web 模式打开 Skills 页直接报错；补上 `_readHermesDisabledSkills` helper，与 Rust 端 `read_disabled_skills` 同语义（缩进感知 YAML 解析）
- **Web/桌面下载行为分流** — `hermes_logs_download` 根据运行时区分桌面真实落盘与 Web Blob 下载，避免 Web 模式误保存到服务端目录
- **普通记忆文件下载提示** — Blob 下载提示改为说明浏览器默认下载目录，减少"下载没落点"的误解
- **`models.js` 多处 typo** — 修复 5 处 `star/start`、`abor/abort`、`textConten/textContent`、`resul/result` 错字（疑似上一次编辑被中断的残留）
- **死代码清理** — 删除 `src/style/pages.css` 中 56 行 `.hm-memory-*` 旧布局规则（编辑改版后已改用 `.hm-mem-*` 前缀，老类零引用）；CSS lint 顺手补 `line-clamp` 标准属性
- **Dependabot #11** — 升级 `rustls-webpki` 至 `0.103.13`，修复畸形 CRL BIT STRING 触发 panic 的拒绝服务风险
- **Dependabot #12** — 升级 `postcss` 至 `8.5.10`，修复 CSS stringify 输出中的 XSS 风险
- **rand 依赖更新** — 升级直接使用的 `rand` 至 `0.8.6`；Tauri 构建期传递依赖中的 `rand 0.7.3` 仍需等待上游解除

## [0.13.4] - 2026-04-20

### 改进 (Improvements)

- **模型列表 404 友好提示** — 部分服务商不提供 /models 列表接口（如 MiniMax 等），之前会显示 `HTTP 404 Not Found` 技术错误，现在改为弹窗提示「该服务商不支持自动获取，请手动填写模型 ID」，并提供一键进入手动添加流程
- **助手设置「获取列表」走后端** — 改为通过 Rust 后端代理请求，解决部分服务商不返回 CORS 头导致桌面端 WebView 报 `Failed to fetch` 的问题
- **HTTP 客户端支持 Brotli / Deflate** — reqwest 启用 brotli、deflate 解码，解决部分 API 返回压缩响应时 body 解析异常

### 修复 (Fixes)

- **测试按钮空响应** — 模型测试改用 stream: true + SSE 累积方式，绕开部分兼容网关 non-streaming 分支返回空 body 的已知 bug，行为与真实对话一致
- **测试诊断信息增强** — 后端返回完整响应头、字节数、前 200 字节 hex dump，前端展示完整模型回复与请求详情，方便用户自查上游问题
- **#236 Linux 全新系统部署失败** — 修复一键部署脚本中 npm 缓存被 root 拥有导致的 `EACCES` / `TAR_ENTRY_ERROR` 错误，新增缓存权限预检与自动修复，npm install 失败时自动清理 node_modules 后重试

## [0.13.3] - 2026-04-16

### 修复 (Fixes)

- **#212** 修复聊天界面 AI 消息内容在气泡中间区域空白的问题
- **#215** 修复 HTTPS 页面下 WebSocket 测试因写死 `ws://` 触发 Mixed Content 被拦截的问题
- **#219** 修复多实例共存时版本号检测错误：优先通过 `openclaw status --json` 读取运行中实例版本，并调整 CLI 路径查找优先级
- 修复引擎切换后仪表盘无限加载：给 `engine.boot()` 增加 10 秒超时，切换时清空 API in-flight 缓存
- 修复仪表盘请求超时：将整体 15 秒超时拆分为各请求独立超时，避免单个慢接口拖垮整个页面
- 修复热更新「假更新」循环（macOS/Linux）：`check_frontend_update` 优先读取已下载的 `.version` 文件，下载后写入版本号；CI release 构建前自动同步版本号

---

## [0.13.2] - 2026-04-13

### 新功能 (Features)

- **Hermes 日志查看器** — 新增 Agent 日志页面，支持文件列表、级别过滤、关键词搜索，左右分栏布局实时浏览日志
- **Hermes Skills 浏览器** — 新增 Skills 页面，左侧分类列表 + 右侧 Markdown 详情预览
- **Hermes 记忆编辑器** — 新增记忆文件页面，支持查看和编辑 Agent 笔记（MEMORY.md）与用户画像（USER.md）
- **Hermes 定时任务可视化** — 定时任务页面全新重写：统计卡片、快捷预设按钮（每5分钟/每小时/每天9:00等）、cron 表达式实时人性化预览、SVG 图标操作按钮

### 改进 (Improvements)

- **仪表盘模型配置折叠** — 模型配置区域默认折叠，点击可展开/收起，节省仪表盘空间
- **定时任务执行反馈** — "立即执行"按钮点击后显示✓/✕状态闪烁，明确告知执行结果
- **Hermes CLI 命令完整对接** — Rust 后端新增 sessions/logs/skills/memory 全套 CLI 命令，Web 后端同步实现
- **API 代理认证注入** — `hermes_api_proxy` 自动从 .env 注入 API_SERVER_KEY，解决 Cron 等页面 "Invalid API key" 错误

### 修复 (Fixes)

- **定时任务显示 [object Object]** — 正确解析 Gateway 返回的 schedule 对象（`{kind,expr,display}`），提取 cron 表达式显示
- **定时任务保存 'str' has no attribute 'get'** — 保存时发送 `{kind:'cron', expr:...}` 对象格式，匹配 Gateway 期望的结构
- **ClawPanel 误杀外部 Gateway** — `cleanup_zombie_gateway_processes` 不再杀死外部启动的健康 Gateway 进程，改为采纳其 PID
- **croniter 依赖缺失** — `uv tool install` 添加 `--with croniter`，确保定时任务功能开箱即用
- **API 代理错误提取** — 修复嵌套错误对象（`{error:{message:...}}`）的提取逻辑

---

## [0.13.1] - 2026-04-13

### 新功能 (Features)

- **Hermes 安装本地/自定义模式** — 安装步骤新增「本地」和「自定义」双模式切换：本地模式一键安装核心包；自定义模式可输入已有 Gateway URL 直接连接，适合已手动安装或远程部署的用户
- **Hermes 管理模态框** — 关于页面 Hermes 卡片的配置/升级/卸载操作改为模态框交互，升级和卸载过程支持实时日志 + 进度条显示

### 改进 (Improvements)

- **安装流程精简** — Hermes 安装移除可选组件（extras）选择 UI，只安装核心包，最大化安装成功率；扩展组件可在安装后按需添加
- **安装实时反馈** — 安装过程内嵌实时日志面板 + 进度条 + 百分比显示，用户可直观感知进度
- **引擎切换骨架屏** — 切换引擎模式和初始启动时显示骨架屏动画，消除内容区空白等待期
- **仪表盘加载动画** — Hermes 仪表盘在数据加载期间显示骨架屏，替代之前的空白页面

### 修复 (Fixes)

- **安装 "Executable already exists" 错误** — `uv tool install` 添加 `--force` 标志，解决重复安装时可执行文件已存在的报错
- **安装失败错误处理** — 安装失败时显示醒目的红色错误提示框（含详细错误信息），保留日志面板供排查，进度条变红，按钮变为「重试」
- **引擎切换后侧边栏不更新** — 切换引擎后调用 `engine.boot()` 检测实际状态，并通过 `onEngineChange` 重绑状态监听，确保侧边栏菜单正确反映新引擎的就绪状态
- **Setup 步骤指示器可点击** — 已完成的步骤可点击返回查看，不再自动跳转仪表盘
- **面板更新检测（Web 模式）** — `check_panel_update` 实现 GitHub/Gitee API 查询，Web 模式可正常检测新版本
- **废弃翻译键清理** — 移除 14 个不再使用的热更新相关 i18n 键

---

## [0.13.0] - 2026-04-13

### 新功能 (Features)

- **Hermes Agent 多引擎支持** — 新增 Hermes Agent 引擎，与 OpenClaw 双引擎并行，自由切换、各自独立管理。包含完整的 Hermes 仪表盘、服务管理、模型配置、Agent 管理等页面
- **Hermes Agent 对话** — 内置 Hermes Agent 聊天界面，支持工具调用可视化、SSE 流式输出、多会话管理、Slash 命令
- **文件系统访问开关** — Hermes Agent 对话新增文件访问开关，开启后 Agent 可读取本机文件，自动适配 Windows/macOS/Linux 命令
- **多安装清理工具** — OpenClaw 多安装检测与一键清理，支持查看所有安装路径、卸载命令、CLI 绑定

### 改进 (Improvements)

- **官网与文档全面更新** — 官网 index.html、所有 11 语言 README 更新为多引擎架构描述，SEO meta/OG/Twitter Card/Schema.org 同步更新
- **内部文档整理** — 规划与开发文档从 docs/ 迁移至 .tmp/，不再对外暴露

### 修复 (Fixes)

- **Gateway 冲突引导优化** — 外来 Gateway 冲突弹窗新增一键清理按钮，直接跳转安装管理

---

## [0.12.0] - 2026-04-11

### 新功能 (Features)

- **OpenClaw 4.9 全面适配** — 完成上游 OpenClaw `2026.4.9` 全量兼容性审查（180+ 文件 diff），涵盖 Gateway RPC、Agent 配置 schema、渠道插件基础设施、Setup wizard、所有消息渠道（LINE/Matrix/Slack/Teams/Telegram 等），确认完全兼容

### 改进 (Improvements)

- **推荐内核统一升级** — `openclaw-version-policy.json` 全版本（0.9.0 ~ 0.12.0）推荐内核统一升级至 `2026.4.9`（官方版）/ `2026.4.9-zh.2`（汉化版），不再保留旧版 3.13 / 3.28 映射
- **安装流程稳健性提升** — 旧版本清理（npm uninstall）增加 30 秒超时保护，清理失败不阻断安装成功报告；Windows 进程检测从废弃的 wmic 迁移到 PowerShell Get-Process / Get-CimInstance，兼容 Windows 11
- **Standalone 安装包适配** — 兼容 CI 新版 edition 格式 `latest.json`（`editions.zh.version`），修正文件名前缀（`openclaw-zh-`）和 R2 下载路径（`/zh/{version}/`），同时保持旧 flat 格式向后兼容

## [0.11.6] - 2026-04-07

### 新功能 (Features)

- **Skills 多 Agent 支持** — Skills 页面新增 Agent 选择器，不同 Agent 可独立管理各自的 Skills 目录；后端 Rust/Node.js 双端均支持 agent_id 参数路由
- **助手工具模式流式输出** — 晴辰助手工具调用模式从非流式改为流式，AI 文字逐 token 打字机显示，tool_calls 分块累积后再执行

### 改进 (Improvements)

- **OpenClaw 4.5 兼容** — 实时聊天页面支持全部 Agent 事件流（lifecycle / item / plan / approval / thinking / command_output），新增 3 分钟终极超时和实时计时器，解决无回复时 UI 永远卡住的问题
- **热更新替换为稳定版下载** — 关于页和全局更新横幅不再展示热更新/重载，改为引导用户前往官网或 GitHub 下载最新稳定版

### 修复 (Fixes)

- **Gateway 状态抖动** — 仪表盘刷新增加 5 秒节流和并发保护；TCP 端口检测增加重试（1s+2s）；Gateway 停止判定从 2 次提高到 3 次连续检测；自动重启前增加 3 秒延迟确认
- **助手空灰色气泡** — 修复流式响应 0 内容块时静默成功导致空消息持久化的 bug；新增流内错误事件捕获、渲染时过滤空消息、finally 块清理机制

## [0.11.5] - 2026-04-07

### 新功能 (Features)

- **SkillHub 技能商店（SDK 化）** — Skills 页面新增"搜索安装"商店 tab，支持浏览全量索引、客户端实时过滤、一键安装；底层从 CLI 调用全面迁移到内置 HTTP SDK（Rust + Node.js 双端），不再依赖 OpenClaw CLI 即可搜索和安装社区 Skill

### 改进 (Improvements)

- **Skills 命令层精简** — 移除 6 个旧 CLI 依赖命令，新增 3 个 SkillHub SDK 命令（search / index / install），本地扫描命令改为纯文件系统操作
- **AI 助手工具迁移** — 晴辰助手的 Skill 搜索/安装工具从 ClawHub CLI 调用迁移到 SkillHub SDK，工具定义、系统提示、handler、显示标签全部更新
- **前端 CSS 清理** — 移除 13 条不再使用的旧 Skills 页面样式（hero 展示区、tips 区域）

### 修复 (Fixes)

- **技能索引加载失败** — 修复 SkillHub 索引 API 返回 `{total, skills}` 包装对象导致 JSON 解码失败的问题（Rust 端新增 `IndexResponse` 包装结构体，Node.js 端提取 `.skills` 字段）
- **技能名称显示** — 修复商店列表因 API 字段名不匹配（`name` vs `display_name`）导致只显示 slug 的问题

## [0.11.4] - 2026-04-06

### 新功能 (Features)

- **聊天气泡一键复制** — 实时聊天和晴辰助手的消息气泡新增复制按钮，悬停显示，点击后有 ✓ 反馈
- **Git 路径扫描** — 设置页 Git 路径配置新增"扫描"按钮，自动检测常见安装位置（Program Files、Scoop、Chocolatey、GitHub Desktop、VS Code、MSYS2、Homebrew、Xcode CLT 等），可一键选用

### 修复 (Fixes)

- **IME 输入法回车误发** — 中日韩输入法组合输入时，按回车确认候选词不再误发消息（assistant.js 补充 `isComposing` + `keyCode 229` 检测）
- **Gateway 外部实例误报** — 外部启动的 Gateway（systemd / Docker / 手动）现在会自动认领，不再误判为"外部实例"弹出引导弹窗；`ensure_owned_gateway_or_err` 和 `get_services_status` 均增加端口 + 数据目录匹配时的自动认领逻辑
- **Gateway 状态不一致** — 服务页外部 Gateway 显示黄色警告点而非绿色；顶栏区分外部 Gateway（警告 + 认领）与已停止（信息 + 启动）；操作后立即同步全局状态
- **模型 fallback 自动填充** — 模型保存时不再自动填充 fallback 预设 (fixes #190)
- **自定义 Git 路径** — 支持用户自定义 Git 可执行文件路径，Skills 打包路径增强

### 安全 (Security)

- **依赖补丁** — picomatch 4.0.4、rustls-webpki 0.103.10 安全更新

## [0.11.3] - 2026-04-03

### 修复 (Fixes)

- **推荐稳定版映射** — `0.11.1` / `0.11.2` 现在会正确继承并显示 OpenClaw `2026.3.28` / `2026.3.28-zh.2`，不再错误回退到旧的 `2026.3.13` 默认值；桌面端 Rust 后端和 Web 模式 `dev-api` 统一采用同一套 panel patch 版本兜底匹配逻辑
- **多安装提示误报** — 仪表盘检测到多个 OpenClaw 安装时，若用户已经显式绑定 CLI，则不再继续显示橙色告警和“去配置”按钮，避免误导已经完成绑定的用户
- **托管 Agent 地址校验** — 托管 Agent 现在会规范化并校验第三方模型地址，自动清理 `/chat/completions`、`/models`、`/api` 等尾部路径，兼容 OpenAI / Anthropic / Gemini / Ollama，并拦截无效的 `tauri.localhost` 或非 `http(s)` 地址

### 改进 (Improvements)

- **多安装引导弹窗重构** — “检测到多个 OpenClaw 安装”对话框改为更适合新手理解的卡片式布局，新增“为什么会看到这个提示”、当前绑定/自动检测信息卡、步骤化建议和高亮的安装列表
- **Tauri 运行时检测统一** — 抽出 `isTauriRuntime()` 统一判断桌面端环境，减少 `window.__TAURI_INTERNALS__` 直判带来的分支分散问题，改善主入口、聊天页和调试页的 WebSocket/桌面环境兼容性

## [0.11.2] - 2026-04-02

### 修复 (Fixes)

- **Gateway 归属误判** — 放宽 Gateway owner 判定，改为按端口 / CLI 路径 / OpenClaw 目录签名识别当前绑定实例，不再因 PID 漂移把当前面板已启动且可正常聊天的 Gateway 误判为“外部实例”；检测到 PID 变化时会自动回写 `gateway-owner.json`，修复服务页误报、Dashboard 外部实例提示以及顶部“Gateway 未运行”误报 (fixes #176)

## [0.11.1] - 2026-04-02

### 改进 (Improvements)

- **Windows 双版本安装包** — 新增 Windows 完整包（含 WebView2 离线安装器，~200 MB），适合内网/断网环境；默认安装包恢复为轻量版（~10 MB），Win10 1803+ / Win11 已预装 WebView2 无需额外下载

## [0.11.0] - 2026-04-02

### 新功能 (Features)

- **聊天文件面板** — 实时聊天页面新增工作区文件面板，可浏览和管理 Agent 工作区文件
- **渠道引导优化** — 改进渠道配置和初始设置引导流程，降低上手门槛
- **配置校准修复** — 服务页面新增「继承修复」和「重置修复」两种配置校准模式，可一键修复 openclaw.json 配置异常
- **MiniMax 模型预设** — 新增 MiniMax M2.7 / M2.5 系列模型预设，更新 API 地址到 api.minimax.io (#163)
- **OpenClaw 3.28 策略映射** — 新增 `0.11.0` → 官方版 `2026.3.28` / 汉化版 `2026.3.28-zh.2` 的推荐稳定版映射

### 修复 (Fixes)

- **Linux 安装权限** — 重构 Linux npm 全局安装提权机制：`sudo -E` 替换为 `pkexec` 图形密码对话框，降级到 `sudo --non-interactive`；自动检测 nvm/fnm/volta 用户目录跳过提权 (fixes #175)
- **Gateway 死循环** — `_autoPairAndReconnect` 配对成功后不再调用 `reconnect()` 重置计数器，防止 origin not allowed 修复触发无限循环阻塞服务器 (fixes #160)
- **readConfig 未定义** — Web 模式替换为内联 `fs.readFileSync/writeFileSync` (fixes #165)
- **systemd PATH 缺失** — `findOpenclawBin` 添加 npm 全局路径，systemd 服务注入 PATH 环境变量 (fixes #156)
- **Docker 双容器冲突** — 新增 `DISABLE_GATEWAY_SPAWN` 环境变量，禁止 ClawPanel 容器启动本地 Gateway (fixes #159)
- **Gateway 检测冲突** — `linuxCheckGateway` 验证进程名，拒绝操作非 OpenClaw 进程 (fixes #151)
- **版本源检测重构** — standalone 目录集中化、Windows .cmd shim 解析、Linux 检测补全，修复跨源切换后显示旧源的问题 (#161)
- **汉化版检测兜底** — 版本号含 `-zh` 时强制判定为汉化版，不再依赖文件系统路径检测
- **Gateway 状态误报** — 避免 PID 查找失败时错误报告 Gateway 已停止
- **配置 profiles 污染** — 自动清理 `auth.profiles` / `agents.profiles` 等被误注入的字段
- **仪表盘运行态误导** — Dashboard 仅在 Gateway 运行时才请求状态摘要，停止时清空旧缓存
- **确认弹窗溢出** — 修复内容过长时确认对话框溢出的样式问题
- **版本同步脚本** — `npm run version:set` 现在会一并同步 `package-lock.json`

### 改进 (Improvements)

- **Gateway 兼容性** — 改进 Gateway 协议兼容性和完善 i18n 清理
- **维护文档** — 更新版本维护和 OpenClaw 3.28 兼容性文档
- **README** — 新增升级/卸载教程，更新致谢列表（octo-patch, SEVENTEEN-TAN, roc-xie 等贡献者）

## [0.10.0] - 2026-03-26

### 新功能 (Features)

- **开机自启** — 面板设置新增开机自启开关，基于 tauri-plugin-autostart（仅桌面版）
- **Gateway 一键修复** — 启动失败时顶部 banner 显示「一键修复」按钮，弹窗执行 `openclaw doctor --fix` 并显示实时日志，修复完成自动重启 Gateway
- **渠道插件版本智能适配** — 安装渠道插件时自动匹配用户 OpenClaw 版本（@openclaw/ 前缀包 pin 版本号，微信/QQ 独立版本号不 pin）
- **微信插件兼容检测** — 检测已安装微信插件与 OpenClaw 版本的兼容性，不兼容时显示红色警告 + 升级引导 + 手动安装命令
- **微信扫码二维码渲染** — 安装/登录流程中自动检测微信 QR URL 并渲染为可扫描的二维码图片
- **赞助项目区域** — 关于页面新增赞助区域（BNB QR 码 + 点击预览大图，仅非中文语言显示）
- **联系邮箱** — 关于页面商务合作改为 support@qctx.net 可点击邮箱链接

### 修复 (Fixes)

- **仪表盘版本缓存** — 切页后版本信息不再丢失，新增持久化缓存 + 实例切换自动清空 (fixes #145)
- **macOS 手动安装检测** — 兼容 standalone (~/.openclaw-bin)、/opt/openclaw、Homebrew ARM/Intel 路径，无 plist 时返回默认 Gateway 条目 (fixes #144)
- **更新提示持久化** — 全局更新 banner 从 sessionStorage 改为 localStorage，关闭后不再每次重启都弹 (fixes #146)
- **AI 助手 Web 模式** — Web 部署模式下 AI 测试走后端代理绕过 CORS (fixes #148)
- **子 Agent 模型配置** — 不再在切换默认模型时强制覆盖所有子 Agent 的 model.primary (fixes #142)
- **nvm 版本排序** — nvm/fnm 版本目录按倒序排列，最新版 Node.js 优先检测 (fixes #143)
- **热更新 banner** — 热更新下载后记录已应用版本到 localStorage，重载后不再重复提示
- **版本号解析** — 修复 `openclaw --version` 输出解析，正确取版本号而非 commit hash（影响版本显示、升级检测、插件兼容判断）
- **插件 minHostVersion 检测** — 插件安装失败时检测宿主版本不满足，给出明确升级提示
- **微信插件清理** — 重装前自动删除旧插件目录 + 清理 openclaw.json 残留配置

### 改进 (Improvements)

- **插件安装体验** — 网络慢时显示「正在下载，请稍候」提示，避免空白等待
- **i18n 国际化** — 新增 Guardian 修复弹窗 15 个 key + 渠道兼容 2 个 key + 赞助 2 个 key（11 种语言）
- **10 个非中文 README** — 新增 Sponsor + Contact 区域（BNB QR + support@qctx.net）

## [0.9.9] - 2026-03-24

### 新功能 (Features)

- **完整 i18n 国际化** — 全部页面使用 t() 国际化，侧边栏语言切换器（可搜索上拉下拉框），支持 11 种语言
- **多语言 README** — 新增日本語、한국어、繁體中文、Tiếng Việt、Español、Português、Русский、Français、Deutsch 共 9 个 README 文件
- **模型配置 Ollama 原生支持** — API 类型新增 `ollama` 选项，自动跳过 /v1 追加，助手页面显示 Ollama 专属提示

### 修复 (Fixes)

- **Cron 投递参数格式** — delivery mode 从错误的 `push` 修正为 `announce`，移除无效的 `to` 字段 (fixes #141)
- **Cron 单渠道用户** — 允许单渠道用户选择投递渠道（之前 ≤1 个渠道会隐藏选择器）
- **Cron 编辑保留投递** — 任务编辑时正确保留 delivery 字段
- **Ollama 配置覆盖** — ClawPanel 不再将用户手动配置的 `api: "ollama"` 覆盖为 `openai-completions` (fixes #140)
- **版本检测错误** — Windows 下优先通过 CLI 路径判断安装来源，默认返回 `official` 而非 `chinese` (fixes #139)
- **版本号读取** — npm 全局目录按活跃 CLI 来源决定检查顺序，避免读到非活跃包的旧版本号
- **助手 API 类型一致性** — `normalizeApiType` 统一 `google-generative-ai` 键名，修复 `requiresApiKey` 判断

### 改进 (Improvements)

- **官网品牌更新** — 公益 AI 接口 → 晴辰云 AI 接口，新增合规声明
- **官网 SEO 优化** — meta 标签新增晴辰云、晴辰助手、Discord、多语言等关键词
- **官网 Footer** — 新增 11 语言 README 链接行
- **元宝派链接更新** — 全站更新为新链接
- **移除独立安装包推广** — 下载区移除过时的 OpenClaw 独立安装包推广块

## [0.9.8] - 2026-03-23

### 新功能 (Features)

- **渠道管理全面增强** — 新增渠道列表 + Agent 绑定双面板布局，支持渠道卡片批量管理
- **10 大消息渠道全覆盖** — QQBot、Telegram、Discord、Slack、飞书、钉钉、微信、Signal、Matrix、MS Teams 全部支持面板内配置、保存、校验
- **Signal 在线校验** — 新增 signal-cli HTTP daemon 连通性检测（/v1/about 端点），返回 API 版本信息
- **MS Teams 在线校验** — 新增 Azure AD OAuth2 client_credentials 流程校验 App ID / App Password / Tenant ID
- **微信 ClawBot 集成** — 腾讯微信官方 `@tencent-weixin/openclaw-weixin` 插件一键安装 + 扫码登录，QR 码 Canvas 渲染（手机可扫描）、插件版本检测与升级提示、登录后自动写入渠道配置并刷新列表
- **QQ 渠道诊断** — QQBot 渠道增加专属诊断工具，检测插件安装、配置状态
- **Agent 绑定 CRUD** — 支持在面板内直接创建/编辑/删除 Agent 路由绑定
- **渠道标签映射** — 新增 channel-labels.js，统一中文渠道名称（如 telegram→Telegram, discord→Discord）
- **Docker 部署支持** — 新增 Dockerfile 多阶段构建 + docker-compose.yml + 一键部署脚本
- **Skills 管理增强** — Skill 验证、扫描、安装功能全面增强，支持 fullPath 检测
- **Messaging 插件迁移** — QQBot 插件自动迁移到 @tencent-connect/openclaw-qqbot

### 修复 (Fixes)

- **WhatsApp 渠道移除** — 上游 WhatsApp 插件运行时未加载（Gateway `web.login.start` 返回 `not available`），暂时移除；改用微信官方渠道替代
- **messaging.rs 编译错误修复** — 修复 `insert_array_as_csv` 缺少引用、Matrix/MS Teams 保存时 `cfg` 双重可变借用导致编译失败
- **Gateway PID 检测逻辑修复** — Windows `is_process_alive` 从错误的前缀匹配改为精确 PID 字段解析
- **JSON 配置修复重写** — `fix_common_json_errors` 单引号修复和注释剥离完全重写，避免截断 URL 中的 `//`
- **Linux 异步阻塞修复** — `check_service_status` 和 `start_service_impl` 中的同步 TCP 连接改用 `spawn_blocking`
- **XSS 安全修复** — channels.js `showWarning`、main.js `errMsg`、agents.js `renderBindingBadges` 和错误加载均添加 HTML 转义
- **渠道卡片编辑按钮修复** — 已接入渠道卡片的「编辑」按钮缺失 click handler，点击无响应；现已补全事件绑定
- **微信渠道检测修复** — 微信登录后自动写入 `channels.openclaw-weixin` 配置，修复 `platform_list_id` / `platform_storage_key` 双向映射，登录后立即刷新列表
- **Vite 代理修复** — 移除重复 `ws: true`、无效 `econnreset` 事件监听，修复 WebSocket socket 错误处理
- **Docker 部署修复** — .dockerignore 不再排除 src/，volume 挂载路径与 Dockerfile USER 一致
- **心跳检测修复** — WebSocket 首次连接时 `_lastMessageAt` 初始化为 `Date.now()`，避免心跳永远不触发
- **PID 安全假设修复** — `get_gateway_pid_by_port` 读不到命令行时不再假定为 Gateway

### 改进 (Improvements)

- **Win11 wmic 兼容** — `read_process_command_line` 优先使用 PowerShell `Get-CimInstance`，fallback 到 wmic
- **macOS Intel 路径兼容** — 版本检测和来源检测同时查找 `/opt/homebrew`（ARM）和 `/usr/local`（Intel）
- **macOS PID 检测** — 服务状态检测新增 `lsof` 获取 PID，不再始终返回 None
- **Windows 路径兼容** — Skills fullPath 验证支持 Windows 盘符路径（如 `C:\`）
- **gateway_listen_port 缓存** — 新增 5 秒缓存，避免服务检测时频繁读文件解析 JSON
- **第三方 API 接入引导优化** — 移除内置密钥，改为引导式流程（注册→填密钥→选模型），新增助手↔OpenClaw 双向同步按钮（带确认框）
- **API 错误信息完整展示** — 模型测试和助手测试的 API 错误（如 429 限流）完整显示 error.message，URL 自动转为可点击链接，方便排查和引流
- **飞书渠道升级** — 从 `@openclaw/feishu` 迁移到飞书官方插件 `@larksuite/openclaw-lark`，支持文档读写、多维表格、日程等高级能力，一键扫码创建机器人；保存新插件配置时自动禁用旧 feishu 插件防止冲突
- **日间/夜间模式圆形扩散动画** — 主题切换时新主题从指定角落以圆形向外扩散覆盖整个页面（View Transitions API），白切黑从左下角、黑切白从右上角，不支持的浏览器自动降级
- **Gateway 重启防卡死** — `gateway_command` 增加 20s 超时，超时后自动 force-kill 残留进程并 fresh start；全平台启动前端口占用检查防止重复拉起；Guardian 自动守护在 Tauri 桌面端也启用；状态轮询间隔从 30s 缩短至 15s
- **Regex 编译优化** — 多行注释正则改用 LazyLock 静态编译
- **Agent 配置注释修正** — `agents.profiles` 注释修正为上游实际的 `agents.list`
- **Linux cmd 候选清理** — 移除 Unix 平台上无意义的 `openclaw.cmd` 候选路径
- **微信渠道升级体验** — 升级操作不再弹出扫码二维码，按钮文案区分安装/升级
- **版本更新检测** — CI 不再将 minAppVersion 写死为当前版本，修正 latest.json 生成逻辑
- **全平台 Clippy 修复** — 修复 Linux/macOS/Windows 上的 Rust Clippy 警告（strip_prefix、dead_code、unnecessary_unwrap 等）
- **Linux Gateway 守护** — Linux 平台补齐 Duration 导入和 cleanup_zombie_gateway_processes 实现（通过 fuser 查端口占用进程并 kill）

### 待规划 (Planned)

> 以下为已归档的规划方案摘要，原独立文档已清理。

- **Gateway 运行检测重构** — 用统一的「端口 + HTTP 探针」方案替换当前各平台复杂的进程/netstat/launchctl 检测逻辑，跨 Windows/macOS/Linux 统一实现。核心思路：先查端口占用确认进程存在，再发 HTTP 请求确认是 Gateway（`GET /v1/health` 或 `/v1/version`）。详见原 `docs/gateway-detection-plan.md`
- **AI 助手功能扩展** — 五大模块：① Docker/WSL 管理（容器操作、镜像管理）② Web 搜索（搜索引擎集成、结果注入上下文）③ SSH 远程管理（连接/命令/文件传输）④ 知识库/灵魂迁移（导入导出 Agent 灵魂与知识）⑤ 模型配置自动导入（从服务商 API 自动发现模型）。详见原 `docs/assistant-features-plan.md`
- **Docker 多实例管理** — API 代理 + 实例切换架构，支持一台机器部署多个 OpenClaw Docker 实例并在面板内统一调度。涉及 dev-api.js 代理层、前端实例选择器、数据隔离。详见原 `docs/docker-multi-instance-plan.md`
- **国际化 (i18n)** — 基于 i18n.js 核心模块实现中英双语，语言包 JSON 结构，按页面逐步迁移硬编码中文字符串。包含语言检测、降级策略、参数插值。详见原 `docs/i18n-plan.md`
- **命令执行权限管理** — AI 助手执行终端命令时支持白名单/黑名单规则，四种模式（确认/白名单/黑名单/无限），glob 通配符匹配，存储于 `clawpanel.json`。详见原 `docs/ROADMAP-v0.9.md`
- **安装体验优化** — 默认安装原版包、保存自定义 Node.js 路径后实时生效验证、Linux Web 版后台一键更新机制
- **其他** — 渠道级消息统计、更多国内模型服务商预设、Rust 原生 Docker API（bollard）、前端热更新增量包

## [0.9.7] - 2026-03-21

### 新功能 (Features)

- **Markdown 表格渲染** — 聊天消息中的 Markdown 表格以 HTML 表格形式展示，支持表头高亮、斑马纹、悬停效果 (#112)
- **Doctor 一键诊断修复** — 新增 `openclaw doctor --fix` 和 `openclaw doctor` 后端命令，支持从面板内自动检测和修复配置问题 (#103)
- **自定义 OpenClaw 安装路径** — 初始设置和服务管理页支持自定义 OpenClaw 配置目录（如 `E:\数据\AI\.openclaw`），解决非默认安装位置的检测问题
- **关闭窗口最小化到托盘** — 关闭主窗口时最小化到系统托盘，不退出应用
- **应用重启命令** — 设置变更后支持从面板内一键重启应用

### 修复 (Fixes)

- **Agent 创建失败兜底** — CLI 创建 Agent 超时或失败时，自动降级为直接写 openclaw.json，不再因 CLI 卡死导致创建失败
- **模型 API 类型自动修复** — 保存时自动将错误的 API 类型（如 `google-gemini` → `google-generative-ai`）修正为上游支持的格式 (#97)
- **SkillHub 安装状态竞态** — 搜索时先实时检测 SkillHub 安装状态，避免缓存误判导致误报"请先安装"
- **聊天响应看门狗** — 发送消息后 15 秒无 delta 事件自动刷新历史，防止响应丢失时 UI 卡在等待状态
- **Clippy 编译警告** — 修复 dead_code 和 manual_flatten 编译警告，代码更规范

### 改进 (Improvements)

- **模型配置可折叠** — 每个服务商区块支持折叠/展开，模型多时页面更清爽 (#98)
- **PATH 检测优先级优化** — macOS/Linux/Windows 均调整为版本管理器路径（nvm/volta/fnm）优先于系统路径，减少环境检测误判
- **聊天 typing 提示增强** — 等待回复时支持显示工具调用等状态提示文字
- **官网内容更新** — 新增 apple-touch-icon、布局优化、图标资源重命名解决浏览器缓存问题
- **贡献者致谢** — README 和 CONTRIBUTING.md 新增历史贡献者致谢名单及维护指南

## [0.9.6] - 2026-03-18

### 修复 (Fixes)

- **仪表盘二次加载崩溃** — 切换页面后返回仪表盘不再报 `Cannot read properties of null (reading 'recommended')` (#100)
- **聊天代码单引号乱码** — 代码块中 `'` 不再显示为 `&#x27;`，修正 Markdown 渲染器的 HTML 转义策略 (#99)
- **聊天图片路径反斜杠丢失** — Windows 路径 `C:\Users\...` 在图片加载失败提示中不再丢失反斜杠
- **聊天页折叠侧边栏后不自适应** — 折叠主侧边栏后聊天页面现在正确撑满全宽
- **Gateway 状态横条延迟** — WebSocket 连接成功后立即刷新 Gateway 状态，不再等待 30 秒轮询周期
- **版本列表加载失败** — 修复 npm registry 返回 gzip 压缩响应时 `error decoding response body` 错误（reqwest 启用 gzip 解压）
- **配置保存后 Gateway 需手动启动** — 所有页面（模型/渠道/通信等）保存 openclaw.json 后自动重载 Gateway（防抖 3 秒），不再需要手动点启动按钮
- **dev.ps1 启动脚本报错** — 修复 PowerShell 解析 emoji 字符时的编码错误

### 新功能 (Features)

- **托管 Agent** — 聊天页新增「⊕ 托管」按钮，可设定任务目标后让 AI 自动循环引导 OpenClaw 执行：
  - 内置系统提示词，明确调度 Agent 的身份和职责
  - 可视化滑块设置最大回复次数（5-200 或 ∞ 无限）
  - 定时自动停止（开关 + 滑块 + 倒计时进度条）
  - 上下文自动压缩（超过 20 条历史自动压缩为摘要）
  - OpenClaw 回复包含「完成/停止」时自动停止循环
  - 单按钮启动/停止切换，运行时输入框自动锁定

### 改进 (Improvements)

- **Toast 通知样式** — 从半透明毛玻璃改为实底+边框+阴影，暗色模式兼容性更好
- **聊天输入框增大** — 最小高度 44px，最大高度 200px，输入体验更舒适

## [0.9.5] - 2026-03-17

### 修复 (Fixes)

- **仪表盘加载卡住** — 从其他页面返回仪表盘时不再永远显示加载占位符，添加错误捕获和重试按钮 (#96)
- **Gemini 模型配置崩溃** — Google Gemini 的 api 类型从错误的 `google-gemini` 修正为 `google-generative-ai`，与上游 OpenClaw 配置规范一致 (#93)
- **聊天代码下划线消失** — Markdown 渲染器的下划线转斜体正则改为 word-boundary 匹配，`my_variable` 等标识符不再被误转 (#92)
- **聊天发送前校验** — Gateway 未就绪时点击发送按钮会提示警告，而非静默失败
- **聊天页空值防御** — `createStreamBubble`、`renderAttachments`、`showPageGuide`、`loadHistory` 等 8 处空值检查，防止快速切页时报错
- **WebSocket 重复连接** — 添加 `_connecting` 状态标记和 `connect()` 防重入守卫，避免重复发起连接

### 新功能 (Features)

- **工具调用渲染** — 聊天消息中的 AI 工具调用（tool call）以可折叠卡片形式展示，包含工具名、状态、时间、参数和结果详情
- **自动滚动控制** — 用户向上滚动查看历史消息时，新回复不再强制跳到底部；点击 ↓ 按钮恢复自动跟随

### 改进 (Improvements)

- **WebSocket 全局单例** — `wsClient` 改为 `window` 级单例，防止热更新时创建重复实例
- **Docker 部署文档** — 新增 FAQ：面板内安装 OpenClaw 失败的原因和解决方案（推荐一体镜像或 Dockerfile 预装）

### 安全 (Security)

- **quinn-proto 漏洞修复** — 更新 quinn-proto 0.11.13 → 0.11.14，修复 QUIC transport parameter 解析 panic (GHSA-6xvm-j4wr-6v98)

## [0.9.4] - 2026-03-17

### 新功能 (Features)

- **OpenClaw 独立安装包** — 全新 standalone 安装方式，自带 Node.js 运行时，零依赖、无需 npm，下载即用。支持 Windows/macOS/Linux/树莓派
- **安装方式选择器** — 初始设置页新增安装方式下拉：自动选择（推荐）/ CDN 加速 / GitHub / npm 编译，汉化版专属
- **GitHub 下载模式** — 支持从 GitHub Releases 下载独立安装包，CDN 不可用时的备选方案
- **动态版本查询** — 安装时动态查询 latest.json 获取最新版本，不怕旧资源被删除

### 改进 (Improvements)

- **默认汉化版** — 未安装状态默认识别为汉化优化版（而非官方版），更符合国内用户习惯
- **CherryStudio 干扰过滤** — CLI 检测过滤第三方 openclaw 二进制（如 CherryStudio），避免误识别
- **安装日志安全** — 日志不再暴露 R2 完整下载地址，防止被恶意利用
- **卸载兼容增强** — 卸载同时清理 standalone 安装目录和 npm 全局安装，覆盖所有可能路径
- **macOS 免 sudo** — standalone 安装到用户目录（~/.openclaw-bin），解决 macOS npm 全局安装权限不足问题
- **官网独立安装包入口** — README 和 docs/index.html 下载区新增独立安装包说明和下载按钮

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
