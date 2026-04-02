# ClawPanel 后端架构详解

## 1. 入口与启动流程

### 1.1 main.rs

```rust
fn main() {
    clawpanel_lib::run()
}
```

### 1.2 lib.rs — run() 函数

`run()` 是整个 Tauri 应用的核心构建器，按顺序完成：

1. **Plugin 注册**：Shell Plugin（执行 CLI 命令）+ Autostart Plugin（开机自启）
2. **URI Scheme Protocol**：注册 `tauri://` 协议，处理热更新文件读取
3. **setup()**：
   - 启动 Guardian 后台守护（`service::start_backend_guardian`）
   - 配置系统托盘（`tray::setup_tray`）
4. **命令注册**：通过 `invoke_handler` 注册 ~90 个 Tauri 命令
5. **窗口事件**：拦截关闭按钮，最小化到托盘而非退出
6. **事件循环**：`run()` 阻塞直到应用退出，Windows 上退出时关闭 Gateway 终端窗口

---

## 2. 命令模块详解

### 2.1 config — 配置管理（commands/config.rs）

**职责**：OpenClaw 配置文件的读写、版本检测、备份恢复、npm/git 配置、诊断修复。

**主要命令**：

```rust
read_openclaw_config()          // 读取 openclaw.json
write_openclaw_config(cfg)      // 写入 openclaw.json
validate_openclaw_config(cfg)   // 校验配置格式
read_mcp_config() / write_mcp_config()  // MCP 配置
get_version_info()               // OpenClaw 版本信息 {current, recommended, latest}
check_installation()             // 检测 Node.js / Git / OpenClaw 安装状态
init_openclaw_config()          // 初始化 openclaw.json
check_node() / check_node_at_path() / scan_node_paths()  // Node.js 检测
save_custom_node_path(path)     // 保存用户指定的 Node.js 路径
write_env_file(key, value)       // 写入 .env 文件
list_backups() / create_backup() / restore_backup() / delete_backup()  // 备份
reload_gateway() / restart_gateway()  // 重载/重启 Gateway
test_model(provider, model, api_key, base_url)  // 测试模型连接
list_remote_models(provider, api_key, base_url)  // 获取服务商模型列表
list_openclaw_versions()        // 获取可用版本列表
upgrade_openclaw(version)       // 升级 OpenClaw
uninstall_openclaw()            // 卸载 OpenClaw
install_gateway() / uninstall_gateway()  // 安装/卸载 Gateway
patch_model_vision()             // 为模型配置添加 vision 支持
check_panel_update()             // 检查面板自身更新
get_openclaw_dir()               // 获取 openclaw 目录路径
read_panel_config() / write_panel_config()  // clawpanel.json
test_proxy(url) / get_npm_registry() / set_npm_registry(url)  // npm 镜像
check_git() / auto_install_git() / configure_git_https()  // Git 配置
invalidate_path_cache()          // 刷新 enhanced_path 缓存
get_status_summary()            // 获取完整状态摘要
doctor_check() / doctor_fix()    // 诊断与修复
relaunch_app()                   // 重启应用
```

### 2.2 service — 服务管理（commands/service.rs）

**职责**：OpenClaw 服务（Gateway/CLI）的启停控制、状态检测、Guardian 守护。

**主要命令**：

```rust
get_services_status()           // 获取所有服务状态 [{label, running, pid, ...}]
start_service(name)             // 启动服务（launchctl / systemd / 直接进程）
stop_service(name)               // 停止服务
restart_service(name)           // 重启服务
guardian_status()               // 获取 Guardian 守护状态
```

**Guardian 守护机制**：
- 应用启动时通过 `start_backend_guardian()` 在后台启动
- 通过 `tauri-plugin-autostart` 注册为 macOS LaunchAgent / Linux systemd 自动启动
- Windows 上使用 `CREATE_NO_WINDOW` 标志避免弹出终端窗口
- 监控 Gateway 进程，崩溃后自动重启

### 2.3 agent — Agent 管理（commands/agent.rs）

**职责**：OpenClaw Agent 的 CRUD、身份编辑、模型绑定、备份。

```rust
list_agents()                   // 列出所有 Agent
add_agent(config)               // 创建新 Agent
delete_agent(id)               // 删除 Agent
update_agent_identity(id, identity)  // 更新 Agent 身份（SOUL/IDENTITY/USER）
update_agent_model(id, model)   // 更新 Agent 模型绑定
backup_agent(id, path)         // 备份 Agent 到指定路径
```

### 2.4 messaging — 消息渠道（commands/messaging.rs）

**职责**：消息渠道（飞书/钉钉/Telegram/Discord/QQ）的配置管理、Bot 校验、渠道绑定。

```rust
read_platform_config(platform)   // 读取平台配置
save_messaging_platform(platform, config)  // 保存配置
remove_messaging_platform(platform)  // 删除配置
toggle_messaging_platform(platform, enabled)  // 启用/停用
verify_bot_token(platform, token)  // 校验 Bot Token
diagnose_channel(platform)         // 诊断渠道问题
repair_qqbot_channel_setup()       // 修复 QQ 机器人配置
list_configured_platforms()        // 列出已配置平台
get_channel_plugin_status(platform) // 获取渠道插件状态
install_channel_plugin(platform)   // 安装渠道插件
install_qqbot_plugin()             // 安装 QQ 机器人插件
run_channel_action(platform, action, params)  // 执行渠道操作
check_weixin_plugin_status()       // 微信插件状态

// Agent-渠道绑定
get_agent_bindings(agent_id)       // 获取 Agent 的渠道绑定
list_all_bindings()                // 列出所有绑定
save_agent_binding(agent_id, platform, channel_id)  // 保存绑定
delete_agent_binding(agent_id, platform, channel_id)  // 删除绑定
delete_agent_all_bindings(agent_id)  // 删除 Agent 所有绑定
```

### 2.5 logs — 日志（commands/logs.rs）

```rust
read_log_tail(source, lines)     // 读取最后 N 行日志
search_log(source, keyword)       // 关键词搜索日志
```

日志来源：Gateway、CLI、clawpanel 自身。

### 2.6 memory — 记忆文件（commands/memory.rs）

```rust
list_memory_files(agent_id)       // 列出记忆文件
read_memory_file(agent_id, path)  // 读取文件内容
write_memory_file(agent_id, path, content)  // 写入文件
delete_memory_file(agent_id, path) // 删除文件
export_memory_zip(agent_id)       // 导出 ZIP
```

### 2.7 pairing — 设备配对（commands/pairing.rs）

```rust
auto_pair_device()                // 自动配对设备（写入 allowedOrigins）
check_pairing_status()            // 检查配对状态
pairing_list_channel()           // 列出配对渠道
pairing_approve_channel(channel)  // 审批配对请求
```

### 2.8 device — 设备密钥（commands/device.rs）

```rust
create_connect_frame()            // 生成 Gateway 握手 Frame（Ed25519 签名）
```

### 2.9 extensions — 扩展工具（commands/extensions.rs）

```rust
get_cftunnel_status()             // cftunnel 状态
cftunnel_action(action)          // cftunnel 启停/配置
get_cftunnel_logs(lines)         // cftunnel 日志
get_clawapp_status()             // ClawApp 状态
install_cftunnel()               // 安装 cftunnel
install_clawapp()                 // 安装 ClawApp
```

### 2.10 skills — Skills 管理（commands/skills.rs）

封装 `openclaw skills` CLI：

```rust
skills_list()                     // 列出已安装 skills
skills_info(name)                 // skill 详情
skills_check(name)               // 检查 skill 状态
skills_install_dep(name)         // 安装 skill 依赖
skills_skillhub_check()          // 检查 SkillHub 连接
skills_skillhub_setup(token)     // 配置 SkillHub
skills_skillhub_search(query)    // 搜索 SkillHub
skills_skillhub_install(name)    // 从 SkillHub 安装
skills_clawhub_search(query)    // 搜索 ClawHub
skills_clawhub_install(name)    // 从 ClawHub 安装
skills_uninstall(name)           // 卸载 skill
skills_validate(name)           // 校验 skill 配置
```

### 2.11 assistant — AI 助手工具（commands/assistant.rs）

**职责**：AI 助手直接调用系统资源的命令。

```rust
assistant_exec(cmd, args)        // 执行 Shell 命令
assistant_read_file(path)        // 读取文件（带内容安全校验）
assistant_write_file(path, content)  // 写入文件
assistant_list_dir(path)         // 列出目录
assistant_system_info()          // 获取系统信息 {os, arch, home}
assistant_list_processes()       // 列出进程
assistant_check_port(port)       // 检测端口占用
assistant_web_search(query)      // 网页搜索
assistant_fetch_url(url)         // 获取 URL 内容

// 图片存储（AI 助手多模态支持）
assistant_ensure_data_dir()       // 确保数据目录存在
assistant_save_image(b64, ext)   // 保存 base64 图片
assistant_load_image(id)         // 加载图片
assistant_delete_image(id)       // 删除图片
```

**安全设计**：
- 读文件：限制在 `~/.openclaw/` 目录下
- 写文件：仅允许写入 `~/.openclaw/` 下的文件
- 执行命令：使用 `enhanced_path()` 确保命令可找到，且受 `clawpanel.json` 中的工具开关控制

### 2.12 update — 热更新（commands/update.rs）

```rust
check_frontend_update()           // 检查前端更新
download_frontend_update(url, hash)  // 下载更新到 web-update/
rollback_frontend_update()       // 回滚更新
get_update_status()              // 获取更新状态
```

热更新文件存放在 `~/.openclaw/clawpanel/web-update/`，由 `lib.rs` 中的 URI Scheme Protocol 优先读取。

---

## 3. 核心工具函数（commands/mod.rs）

### 3.1 openclaw_dir()

```rust
pub fn openclaw_dir() -> PathBuf {
    // 1. 读 ~/.openclaw/clawpanel.json 的 openclawDir 字段
    // 2. 如有自定义路径且存在 → 返回
    // 3. 否则 → ~/.openclaw
}
```

ClawPanel 配置始终在 `~/.openclaw/clawpanel.json`，不受 `openclawDir` 影响。

### 3.2 gateway_listen_port()

```rust
pub fn gateway_listen_port() -> u16 {
    // 读 openclaw.json 的 gateway.port，缺省 18789
    // 5秒缓存，避免频繁读文件
}
```

### 3.3 enhanced_path()

构建完整 PATH，解决 macOS 从 Finder 启动时 PATH 不完整的问题：

```rust
// macOS 追加路径（按优先级）
~/.nvm/current/bin
~/.volta/bin
~/.nodenv/shims
~/n/bin
~/.npm-global/bin
/usr/local/bin
/opt/homebrew/bin
// + nvm 扫描 ~/.nvm/versions/node/
// + fnm 扫描 ~/.local/share/fnm/node-versions/
// + standalone 安装目录

// Linux 类似，额外追加 /usr/bin, /snap/bin, /usr/local/bin

// Windows 追加路径（按优先级）
%NVM_SYMLINK% > NVM_HOME > %APPDATA%\nvm
%LOCALAPPDATA%\fnm
%APPDATA%\npm
standalone 目录
常见安装路径（D:\nodejs 等）
```

### 3.4 HTTP 客户端

```rust
build_http_client(timeout, user_agent)      // 带代理（全局代理）
build_http_client_no_proxy(timeout, user_agent)  // 不带代理（模型请求默认）
```

代理配置来自 `clawpanel.json` 的 `networkProxy`。模型请求默认不走代理（除非用户开启 `proxyModelRequests`）。

---

## 4. 托盘系统（tray.rs）

macOS / Windows 系统托盘配置：

- **托盘菜单**（右键）：
  - 显示/隐藏窗口
  - 启动/停止 Gateway
  - Separator
  - 退出
- **点击行为**：左键切换窗口显示/隐藏

---

## 5. Autostart 配置

通过 `tauri-plugin-autostart` 注册开机自启：

```rust
tauri_plugin_autostart::init(
    tauri_plugin_autostart::MacosLauncher::LaunchAgent,  // macOS
    None  // Windows: 使用任务计划程序
)
```

Guardian 守护通过此机制在系统启动时自动运行，保持 Gateway 始终在线。

---

## 6. 依赖一览

```toml
# 核心
tauri = { version = "2", features = ["tray-icon", "image-png"] }
tauri-plugin-shell = "2"
tauri-plugin-autostart = "2"

# 序列化
serde = { version = "1", features = ["derive"] }
serde_json = "1"

# 工具
dirs = "6"           # 用户目录
chrono = "0.4"       # 时间
zip = { version = "2", default-features = false, features = ["deflate"] }
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls", "stream", "gzip"] }
futures-util = "0.3"
tokio = { version = "1", features = ["process", "time"] }

# 加密
ed25519-dalek = { version = "2", features = ["rand_core"] }
sha2 = "0.10"
rand = "0.8"
base64 = "0.22"
urlencoding = "2"
regex = "1"
```