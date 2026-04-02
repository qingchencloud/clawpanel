# ClawPanel 架构附录

## A. 关键 Tauri 命令索引

按模块分组，约 90 个命令。

### A.1 config 模块

| 前端方法 | Rust 命令 | 功能 |
|----------|-----------|------|
| `api.readOpenclawConfig()` | `config::read_openclaw_config` | 读取 openclaw.json |
| `api.writeOpenclawConfig(cfg)` | `config::write_openclaw_config` | 写入 openclaw.json |
| `api.validateOpenclawConfig(cfg)` | `config::validate_openclaw_config` | 校验配置 |
| `api.readMcpConfig()` | `config::read_mcp_config` | 读取 MCP 配置 |
| `api.writeMcpConfig(cfg)` | `config::write_mcp_config` | 写入 MCP 配置 |
| `api.getVersionInfo()` | `config::get_version_info` | 版本信息 |
| `api.checkInstallation()` | `config::check_installation` | 安装状态检测 |
| `api.initOpenclawConfig()` | `config::init_openclaw_config` | 初始化配置 |
| `api.checkNode()` | `config::check_node` | 检测 Node.js |
| `api.checkNodeAtPath(path)` | `config::check_node_at_path` | 检测指定路径 Node.js |
| `api.scanNodePaths()` | `config::scan_node_paths` | 扫描所有 Node.js 路径 |
| `api.saveCustomNodePath(path)` | `config::save_custom_node_path` | 保存自定义路径 |
| `api.writeEnvFile(key, value)` | `config::write_env_file` | 写入 .env |
| `api.listBackups()` | `config::list_backups` | 列出备份 |
| `api.createBackup(name)` | `config::create_backup` | 创建备份 |
| `api.restoreBackup(name)` | `config::restore_backup` | 恢复备份 |
| `api.deleteBackup(name)` | `config::delete_backup` | 删除备份 |
| `api.reloadGateway()` | `config::reload_gateway` | 重载 Gateway |
| `api.restartGateway()` | `config::restart_gateway` | 重启 Gateway |
| `api.testModel(...)` | `config::test_model` | 测试模型连接 |
| `api.listRemoteModels(...)` | `config::list_remote_models` | 获取模型列表 |
| `api.listOpenclawVersions()` | `config::list_openclaw_versions` | 可用版本列表 |
| `api.upgradeOpenclaw(version)` | `config::upgrade_openclaw` | 升级 OpenClaw |
| `api.uninstallOpenclaw()` | `config::uninstall_openclaw` | 卸载 OpenClaw |
| `api.installGateway()` | `config::install_gateway` | 安装 Gateway |
| `api.uninstallGateway()` | `config::uninstall_gateway` | 卸载 Gateway |
| `api.patchModelVision()` | `config::patch_model_vision` | 添加 vision 支持 |
| `api.checkPanelUpdate()` | `config::check_panel_update` | 检查面板更新 |
| `api.getOpenclawDir()` | `config::get_openclaw_dir` | 获取配置目录 |
| `api.readPanelConfig()` | `config::read_panel_config` | 读取 clawpanel.json |
| `api.writePanelConfig(cfg)` | `config::write_panel_config` | 写入 clawpanel.json |
| `api.testProxy(url)` | `config::test_proxy` | 测试代理 |
| `api.getNpmRegistry()` | `config::get_npm_registry` | 获取 npm 镜像 |
| `api.setNpmRegistry(url)` | `config::set_npm_registry` | 设置 npm 镜像 |
| `api.checkGit()` | `config::check_git` | 检测 Git |
| `api.autoInstallGit()` | `config::auto_install_git` | 自动安装 Git |
| `api.configureGitHttps()` | `config::configure_git_https` | 配置 Git HTTPS |
| `api.invalidatePathCache()` | `config::invalidate_path_cache` | 刷新 PATH 缓存 |
| `api.getStatusSummary()` | `config::get_status_summary` | 状态摘要 |
| `api.doctorCheck()` | `config::doctor_check` | 诊断检查 |
| `api.doctorFix()` | `config::doctor_fix` | 诊断修复 |
| `api.relaunchApp()` | `config::relaunch_app` | 重启应用 |

### A.2 service 模块

| 前端方法 | Rust 命令 | 功能 |
|----------|-----------|------|
| `api.getServicesStatus()` | `service::get_services_status` | 获取服务状态 |
| `api.startService(name)` | `service::start_service` | 启动服务 |
| `api.stopService(name)` | `service::stop_service` | 停止服务 |
| `api.restartService(name)` | `service::restart_service` | 重启服务 |
| `api.guardianStatus()` | `service::guardian_status` | Guardian 状态 |

### A.3 agent 模块

| 前端方法 | Rust 命令 | 功能 |
|----------|-----------|------|
| `api.listAgents()` | `agent::list_agents` | 列出 Agent |
| `api.addAgent(config)` | `agent::add_agent` | 创建 Agent |
| `api.deleteAgent(id)` | `agent::delete_agent` | 删除 Agent |
| `api.updateAgentIdentity(id, identity)` | `agent::update_agent_identity` | 更新身份 |
| `api.updateAgentModel(id, model)` | `agent::update_agent_model` | 更新模型 |
| `api.backupAgent(id, path)` | `agent::backup_agent` | 备份 Agent |

### A.4 messaging 模块

| 前端方法 | Rust 命令 | 功能 |
|----------|-----------|------|
| `api.readPlatformConfig(platform)` | `messaging::read_platform_config` | 读取平台配置 |
| `api.saveMessagingPlatform(...)` | `messaging::save_messaging_platform` | 保存配置 |
| `api.removeMessagingPlatform(platform)` | `messaging::remove_messaging_platform` | 删除配置 |
| `api.toggleMessagingPlatform(...)` | `messaging::toggle_messaging_platform` | 启用/停用 |
| `api.verifyBotToken(platform, token)` | `messaging::verify_bot_token` | 校验 Token |
| `api.diagnoseChannel(platform)` | `messaging::diagnose_channel` | 诊断渠道 |
| `api.repairQQBotChannelSetup()` | `messaging::repair_qqbot_channel_setup` | 修复 QQ |
| `api.listConfiguredPlatforms()` | `messaging::list_configured_platforms` | 已配置平台 |
| `api.getChannelPluginStatus(platform)` | `messaging::get_channel_plugin_status` | 插件状态 |
| `api.installChannelPlugin(platform)` | `messaging::install_channel_plugin` | 安装插件 |
| `api.installQQBotPlugin()` | `messaging::install_qqbot_plugin` | 安装 QQ |
| `api.runChannelAction(...)` | `messaging::run_channel_action` | 执行操作 |
| `api.checkWeixinPluginStatus()` | `messaging::check_weixin_plugin_status` | 微信状态 |
| `api.getAgentBindings(agentId)` | `messaging::get_agent_bindings` | Agent 绑定 |
| `api.listAllBindings()` | `messaging::list_all_bindings` | 所有绑定 |
| `api.saveAgentBinding(...)` | `messaging::save_agent_binding` | 保存绑定 |
| `api.deleteAgentBinding(...)` | `messaging::delete_agent_binding` | 删除绑定 |
| `api.deleteAgentAllBindings(id)` | `messaging::delete_agent_all_bindings` | 删除所有绑定 |

### A.5 logs 模块

| 前端方法 | Rust 命令 | 功能 |
|----------|-----------|------|
| `api.readLogTail(source, lines)` | `logs::read_log_tail` | 读日志尾 |
| `api.searchLog(source, keyword)` | `logs::search_log` | 搜索日志 |

### A.6 memory 模块

| 前端方法 | Rust 命令 | 功能 |
|----------|-----------|------|
| `api.listMemoryFiles(agentId)` | `memory::list_memory_files` | 列出文件 |
| `api.readMemoryFile(agentId, path)` | `memory::read_memory_file` | 读文件 |
| `api.writeMemoryFile(...)` | `memory::write_memory_file` | 写文件 |
| `api.deleteMemoryFile(agentId, path)` | `memory::delete_memory_file` | 删除文件 |
| `api.exportMemoryZip(agentId)` | `memory::export_memory_zip` | 导出 ZIP |

### A.7 pairing 模块

| 前端方法 | Rust 命令 | 功能 |
|----------|-----------|------|
| `api.autoPairDevice()` | `pairing::auto_pair_device` | 自动配对 |
| `api.checkPairingStatus()` | `pairing::check_pairing_status` | 检查状态 |
| `api.pairingListChannel()` | `pairing::pairing_list_channel` | 列出渠道 |
| `api.pairingApproveChannel(ch)` | `pairing::pairing_approve_channel` | 审批渠道 |

### A.8 device 模块

| 前端方法 | Rust 命令 | 功能 |
|----------|-----------|------|
| `api.createConnectFrame()` | `device::create_connect_frame` | 生成握手 Frame |

### A.9 extensions 模块

| 前端方法 | Rust 命令 | 功能 |
|----------|-----------|------|
| `api.getCftunnelStatus()` | `extensions::get_cftunnel_status` | cftunnel 状态 |
| `api.cftunnelAction(action)` | `extensions::cftunnel_action` | cftunnel 操作 |
| `api.getCftunnelLogs(lines)` | `extensions::get_cftunnel_logs` | cftunnel 日志 |
| `api.getClawappStatus()` | `extensions::get_clawapp_status` | ClawApp 状态 |
| `api.installCftunnel()` | `extensions::install_cftunnel` | 安装 cftunnel |
| `api.installClawapp()` | `extensions::install_clawapp` | 安装 ClawApp |

### A.10 skills 模块

| 前端方法 | Rust 命令 | 功能 |
|----------|-----------|------|
| `api.skillsList()` | `skills::skills_list` | 列出 skills |
| `api.skillsInfo(name)` | `skills::skills_info` | skill 详情 |
| `api.skillsCheck(name)` | `skills::skills_check` | 检查状态 |
| `api.skillsInstallDep(name)` | `skills::skills_install_dep` | 安装依赖 |
| `api.skillsSkillhubCheck()` | `skills::skills_skillhub_check` | SkillHub 检查 |
| `api.skillsSkillhubSetup(token)` | `skills::skills_skillhub_setup` | 配置 SkillHub |
| `api.skillsSkillhubSearch(q)` | `skills::skills_skillhub_search` | 搜索 SkillHub |
| `api.skillsSkillhubInstall(name)` | `skills::skills_skillhub_install` | 安装 |
| `api.skillsClawhubSearch(q)` | `skills::skills_clawhub_search` | 搜索 ClawHub |
| `api.skillsClawhubInstall(name)` | `skills::skills_clawhub_install` | 安装 |
| `api.skillsUninstall(name)` | `skills::skills_uninstall` | 卸载 |
| `api.skillsValidate(name)` | `skills::skills_validate` | 校验 |

### A.11 assistant 模块

| 前端方法 | Rust 命令 | 功能 |
|----------|-----------|------|
| `api.assistantExec(cmd, args)` | `assistant::assistant_exec` | 执行命令 |
| `api.assistantReadFile(path)` | `assistant::assistant_read_file` | 读文件 |
| `api.assistantWriteFile(path, content)` | `assistant::assistant_write_file` | 写文件 |
| `api.assistantListDir(path)` | `assistant::assistant_list_dir` | 列目录 |
| `api.assistantSystemInfo()` | `assistant::assistant_system_info` | 系统信息 |
| `api.assistantListProcesses()` | `assistant::assistant_list_processes` | 进程列表 |
| `api.assistantCheckPort(port)` | `assistant::assistant_check_port` | 端口检测 |
| `api.assistantWebSearch(query)` | `assistant::assistant_web_search` | 网页搜索 |
| `api.assistantFetchUrl(url)` | `assistant::assistant_fetch_url` | 获取 URL |
| `api.assistantEnsureDataDir()` | `assistant::assistant_ensure_data_dir` | 确保目录 |
| `api.assistantSaveImage(b64, ext)` | `assistant::assistant_save_image` | 保存图片 |
| `api.assistantLoadImage(id)` | `assistant::assistant_load_image` | 加载图片 |
| `api.assistantDeleteImage(id)` | `assistant::assistant_delete_image` | 删除图片 |

### A.12 update 模块

| 前端方法 | Rust 命令 | 功能 |
|----------|-----------|------|
| `api.checkFrontendUpdate()` | `update::check_frontend_update` | 检查更新 |
| `api.downloadFrontendUpdate(url, hash)` | `update::download_frontend_update` | 下载更新 |
| `api.rollbackFrontendUpdate()` | `update::rollback_frontend_update` | 回滚更新 |
| `api.getUpdateStatus()` | `update::get_update_status` | 更新状态 |

---

## B. CSS Variables 索引

### B.1 颜色

| Variable | Dark 默认 | Light 默认 | 用途 |
|----------|-----------|------------|------|
| `--bg-primary` | `#0f0f0f` | `#ffffff` | 主背景 |
| `--bg-secondary` | `#1a1a1a` | `#f5f5f5` | 次级背景 |
| `--bg-tertiary` | `#252525` | `#ebebeb` | 三级背景 |
| `--bg-hover` | `rgba(255,255,255,0.05)` | `rgba(0,0,0,0.04)` | 悬停背景 |
| `--text-primary` | `#f5f5f5` | `#18181b` | 主文本 |
| `--text-secondary` | `#a1a1aa` | `#52525b` | 次级文本 |
| `--text-tertiary` | `#71717a` | `#a1a1aa` | 三级文本 |
| `--text-inverse` | `#18181b` | `#f5f5f5` | 反色文本 |
| `--border` | `#2e2e2e` | `#e4e4e7` | 边框 |
| `--border-hover` | `#3e3e3e` | `#d4d4d8` | 悬停边框 |
| `--accent` | `#6366f1` | `#6366f1` | 主强调色 |
| `--accent-hover` | `#818cf8` | `#4f46e5` | 强调色悬停 |
| `--success` | `#22c55e` | `#16a34a` | 成功状态 |
| `--warning` | `#f59e0b` | `#d97706` | 警告状态 |
| `--error` | `#ef4444` | `#dc2626` | 错误状态 |
| `--info` | `#3b82f6` | `#2563eb` | 信息状态 |

### B.2 圆角

| Variable | 默认值 | 用途 |
|----------|--------|------|
| `--radius-sm` | `4px` | 小元素 |
| `--radius-md` | `8px` | 按钮、输入框 |
| `--radius-lg` | `12px` | 卡片、面板 |
| `--radius-xl` | `16px` | 大面板 |

### B.3 阴影

| Variable | 默认值 | 用途 |
|----------|--------|------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.3)` | 小阴影 |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,0.4)` | 中阴影 |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,0.5)` | 大阴影 |

### B.4 字体

| Variable | 默认值 | 用途 |
|----------|--------|------|
| `--font-sans` | `system-ui, -apple-system, ...` | 主字体 |
| `--font-mono` | `ui-monospace, SFMono-Regular, ...` | 等宽字体 |
| `--font-size-xs` | `11px` | 超小 |
| `--font-size-sm` | `13px` | 小 |
| `--font-size-base` | `14px` | 基准 |
| `--font-size-lg` | `16px` | 大 |
| `--font-size-xl` | `18px` | 特大 |

---

## C. 关键 Rust 类型

### C.1 配置文件结构

```rust
// clawpanel.json
struct ClawPanelConfig {
    access_password: Option<String>,      // 访问密码
    must_change_password: bool,           // 是否必须修改默认密码
    openclaw_dir: Option<String>,        // 自定义 OpenClaw 目录
    node_path: Option<String>,            // 自定义 Node.js 路径
    network_proxy: NetworkProxy,          // 代理配置
    language: String,                     // 语言
    theme: String,                       // 主题
}

// openclaw.json
struct OpenClawConfig {
    gateway: GatewayConfig,
    model: Vec<ModelConfig>,
    agents: Vec<AgentConfig>,
    channels: Vec<ChannelConfig>,
    // ...
}

struct GatewayConfig {
    port: u16,                           // 默认 18789
    mode: String,                        // "local" | "remote"
    auth: GatewayAuth,
    control_ui: ControlUiConfig,
}

struct GatewayAuth {
    token: Option<String>,              // 访问 Token
    password: Option<String>,           // 密码认证
}

struct ControlUiConfig {
    allowed_origins: Vec<String>,        // 允许的跨域来源
}
```

### C.2 服务状态

```rust
struct ServiceStatus {
    label: String,          // "ai.openclaw.gateway" | "ai.openclaw.cli"
    name: String,           // 显示名称
    running: bool,
    pid: Option<u32>,
    cli_installed: bool,
    version: Option<String>,
}

struct GuardianStatus {
    running: bool,
    give_up: bool,
    last_error: Option<String>,
}
```

### C.3 AI 助手工具响应

```rust
struct AssistantExecResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

struct SystemInfo {
    os: String,       // "macOS" | "Windows" | "Linux"
    arch: String,    // "arm64" | "x86_64"
    home: String,    // 用户主目录
}

struct PortCheckResult {
    port: u16,
    in_use: bool,
    pid: Option<u32>,
    process_name: Option<String>,
}
```

---

## D. 文件路径速查

| 路径 | 说明 |
|------|------|
| `~/.openclaw/openclaw.json` | OpenClaw 主配置 |
| `~/.openclaw/clawpanel.json` | ClawPanel 配置 |
| `~/.openclaw/clawpanel/web-update/` | 热更新文件目录 |
| `~/.openclaw/backups/` | 配置备份目录 |
| `~/.openclaw/agents/` | Agent 数据目录 |
| `~/.openclaw/logs/` | 日志文件目录 |

---

## E. Web 端 API 端点

Web 模式（`serve.js`）提供的 HTTP API 端点：

| 端点 | 方法 | 对应 Tauri 命令 |
|------|------|----------------|
| `/__api/health` | GET | — |
| `/__api/auth_check` | POST | — |
| `/__api/auth_login` | POST | — |
| `/__api/read_openclaw_config` | GET | `config::read_openclaw_config` |
| `/__api/write_openclaw_config` | POST | `config::write_openclaw_config` |
| `/__api/start_service` | POST | `service::start_service` |
| `/__api/stop_service` | POST | `service::stop_service` |
| `/__api/get_services_status` | GET | `service::get_services_status` |
| `/__api/read_log_tail` | GET | `logs::read_log_tail` |
| `/__api/list_memory_files` | GET | `memory::list_memory_files` |
| `/__api/read_memory_file` | GET | `memory::read_memory_file` |
| `/__api/write_memory_file` | POST | `memory::write_memory_file` |
| `/__api/assistant_exec` | POST | `assistant::assistant_exec` |
| `/__api/assistant_read_file` | POST | `assistant::assistant_read_file` |
| `/__api/assistant_write_file` | POST | `assistant::assistant_write_file` |
| `/__api/assistant_list_dir` | POST | `assistant::assistant_list_dir` |
| `/__api/assistant_system_info` | GET | `assistant::assistant_system_info` |
| `/__api/assistant_list_processes` | GET | `assistant::assistant_list_processes` |
| `/__api/assistant_check_port` | POST | `assistant::assistant_check_port` |
| `/__api/check_installation` | GET | `config::check_installation` |
| `/__api/check_node` | GET | `config::check_node` |
| `/__api/reload_gateway` | POST | `config::reload_gateway` |
| `/__api/get_version_info` | GET | `config::get_version_info` |
| `/__api/auto_pair_device` | POST | `pairing::auto_pair_device` |
| `/__api/read_panel_config` | GET | `config::read_panel_config` |
| `/__api/write_panel_config` | POST | `config::write_panel_config` |
| `/__api/patch_model_vision` | POST | `config::patch_model_vision` |

WebSocket 代理：`/ws` → `ws://127.0.0.1:18789/ws`