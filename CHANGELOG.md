# 更新日志

本项目的所有重要变更都将记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
