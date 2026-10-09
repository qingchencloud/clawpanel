# Pi 实验引擎

自 ClawPanel 0.22.0 提供安装、模型配置及独立工作台，继续标记为实验版。完整 OpenClaw 操控对标仍分阶段推进，参见 [复查记录](pi-openclaw-parity-review.md)。

## 使用入口

1. 左侧引擎切换器选择 **Pi**，进入「运行与配置」。
2. 安装受管运行时，要求完整的 Node.js **>=22.19.0** 和 npm；当前推荐安装 `@earendil-works/pi-coding-agent@1.1.0`。
3. 在通用「模型渠道」维护地址、密钥、模型和上下文/输出上限，点击「同步到 Pi」，按需设为默认模型。
4. 配置工作目录，在独立「工作台」新建会话、发送消息和切换模型。

Pi 独立于 OpenClaw Gateway。未安装 OpenClaw 或 Gateway 停止时，也可使用 Pi。
这不是 Pi 原生实验 Web Server 的 iframe：当前采用官方 JSONL RPC，面板提供原生工作台。

## 模型和权限

- 配置转换支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Google Generative AI；Ollama 渠道转到其 OpenAI 兼容 `/v1` 接口。
- 模型 ID、显示名、上下文、输出上限及视觉/推理元数据写入 Pi 配置。未填写上限时交给 Pi 的默认规则，不固定为 50000。
- 目前需要渠道中已保存的 API Key；本地无鉴权服务可按服务约定填写占位 Key。结构化 SecretRef、OAuth 尚未接入。
- 浏览器只提交渠道 ID；后端读取密钥，`models.json` 只保存环境变量引用；凭据保存在受管私有目录，日志脱敏。
- 默认只开放 `read/grep/find/ls`；启用写文件及命令后，`edit/write/bash/powershell` 每次都要确认。
- 路径型工具限制工作目录，拒绝越界、符号链接越界和读取私有凭据目录。**工作目录不是操作系统沙箱**；授权命令仍可访问当前操作系统账号的资源。
- 默认禁用项目扩展、MCP、Skills、提示词模板及上下文文件自动加载；仅加载面板自己的权限守卫。不要把此试用版本作为多用户代码执行隔离服务。

## 运行时与数据布局

数据位于当前 OpenClaw 配置根目录下的 `clawpanel/pi/`，没有全局安装或改写已有 `~/.pi`：

```text
clawpanel/pi/
├── runtime/                   # 独立 npm 包与依赖
├── agent/models.json          # Provider、模型与环境变量引用
├── agent/settings.json        # 默认 Provider / 模型，保留已有未知字段
├── agent/credentials.json     # 私有凭据，不通过状态 API 返回
├── sessions/                  # 官方 Pi JSONL 会话
├── sessions.json              # 面板会话索引
├── config.json                # 工作目录、工具授权
├── permission.mjs             # 面板逐次确认守卫
├── runtime.log                # 脱敏诊断
└── workspace/                  # 默认工作目录
```

- Web：沿用面板的认证与 `/__api/pi_call`，不新增公开 Pi 端口。
- 桌面：Rust 内嵌同一份 Node 适配源码，通过带随机认证令牌的 `127.0.0.1` 随机端口私有桥调用；父管道断开即回收进程。握手有 15 秒超时。
- 状态读取不启动 Pi CLI。会话按需创建，最多同时 3 个；空闲 30 分钟回收，切页面不直接中止任务。
- 使用事件游标与有界事件环，断线不自动重发消息；刷新重新回读历史，事件溢出触发快照恢复。
- 临时连接失败最多进行 6 次指数退避重试，恢复后回读当前状态；失效会话需重新打开，不自动重放任务。
- 工作目录和工具权限只作为新会话默认值；历史会话按自身项目和权限恢复，缺失目录明确报错。旧索引未记录权限的会话按只读恢复。
- 保存完整会话索引；遗漏入口可从受管 JSONL 的合法会话头恢复。列表支持按标题/项目搜索、分批加载和关闭指定会话进程，关闭不删除历史。
- 草稿按受管实例与会话隔离，保存在当前浏览器标签页的 `sessionStorage`，离开页面和刷新后恢复，关闭标签页后结束保存；不发送遥测。后台会话待审批时提供定位提醒。
- `prompt` 接受不代表任务完成；以 `agent_settled` 结束任务。最终消息覆盖流式增量，避免截断及首段重复。
- 原生 RPC `select/confirm/input/editor` 请求按 ID 回传；任意自定义 TUI `custom()` 扩展不在本轮范围。

## 安装、更新与卸载

安装和更新仅接受面板验证过的固定 Pi 版本（本版本为 1.1.0）；检查上游更新由用户触发，未经兼容验收的新版仅提示、不自动切换。先在独立 staging 目录安装并执行版本核验，再切换受管运行时；切换后核验失败恢复旧版本。

管理操作互斥；任务执行中拒绝安装、更新、卸载、模型同步和工作目录变更。卸载只删除受管运行时，保留配置、凭据、会话和工作目录。模型同步写入失败恢复旧配置，并做文件回读；**文件回读不是真实模型调用成功证明**。

## 验证与边界

### 工作台界面

工作台使用全高聊天布局：窄会话栏可收起，手机上改为抽屉；仅消息区滚动，模型选择和输入区固定在底部。安装、更新与权限管理继续放在独立配置页。

模型下拉显示模型名称，内部 Provider ID 只保留在 RPC 参数中。重名模型用模型 ID、地址或序号区分。工具调用和历史结果合并到原调用位置，默认折叠诊断详情；拒绝审批显示“未执行”，主动停止显示“已停止生成”，实际错误仍保留。

流式刷新保留草稿、焦点、滚动位置及工具/思考展开状态，中文输入法合成期间暂缓重绘。快捷提示只填入草稿，不自动发送。

界面回归使用真实 Pi 1.1.0 和本地模拟模型，在 Web 生产服务器上检查亮/暗主题、390×844 与 320×568 小屏布局、模型切换、审批拒绝/允许、停止与刷新恢复。模拟模型响应不是收费 Provider 的真实调用证明。

本轮已在 Windows / Node.js 24.15.0 验证：

- 真 Pi 1.1.0 安装与协议运行，模型元数据回读、两个模型切换。
- 本地 OpenAI 兼容 SSE Provider 的完整回复、Unicode 分隔符、流式增量、中止和会话恢复。
- 真 Pi 写文件审批拒绝不产生文件、允许后产生固定测试回执，等待审批不被错误视为结束。
- Web 生产服务器登录、统一渠道同步、独立配置页/工作台、错误与草稿保留、模型切换、审批、刷新恢复，以及 390px 移动布局无横向溢出。
- Node 回归、前端构建、Rust 单测、格式及 Clippy；桌面私有桥分别由 Node 测试和 Rust 实际启动测试验证认证与退出。

尚未完成：Tauri GUI 整体操作验收，Linux/macOS/ARM64 真机验收，收费 Provider 的真实 Responses/Anthropic/Google/Ollama 调用，任意项目扩展/MCP 和文件附件体验。不要把这些未验收项表述为完整兼容。

### 本地测试

```powershell
node --test tests/*.test.js
npm run build
cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

可选真 Pi 测试使用已经安装 Pi 的隔离 `.tmp` 根目录，未设置环境变量时跳过：

```powershell
$env:PI_REAL_RUNTIME_ROOT = Join-Path (Get-Location) '.tmp/pi-spike'
node --test tests/pi-real-runtime.test.js
```

该测试仅调用本地模拟 Provider，不访问真实收费模型。目录必须在 `.tmp` 中；测试会同步模拟模型、创建新工作目录和会话。

CI 与发布门禁执行下列命令，自动安装固定版本并运行上述测试。三平台 CI 会分别验证原生 RPC 启动，发布构建前再执行同一门禁：

```powershell
node scripts/test-pi-runtime.mjs
```

跨平台 CI 不等于 Tauri GUI 真机验收或收费 Provider 的端到端验收。

## 参考

- [官方项目](https://github.com/earendil-works/pi)
- [固定版本 RPC 文档](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc.md)
- [固定版本 JSON 事件文档](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/json.md)
- [固定版本模型配置文档](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/models.md)
