# Pi 工作台与 OpenClaw 操控对标复查

## 结论与发布范围

对齐日常操作体验可行，保持 Pi 原生 RPC、运行时、项目和权限独立。ClawPanel 0.22.0 发布的是 **Pi 实验引擎及可靠性修复**，不是完整 OpenClaw 操控对标版。

初次检查基于 0.21.9 的未发布实现，发现草稿、项目目录、历史入口和标题问题；下表记录本轮修复与验证，不把初次检查的通过结果当成这些问题已修复的证据。

Pi 基线固定为实际安装测试过的 `@earendil-works/pi-coding-agent@1.1.0`。官方 OpenClaw Control UI 文档用于交互参考，不代表同名功能已经存在于 ClawPanel。

## 本轮修复闭环

| 初次复查发现 | 0.22.0 处理 | 验证 |
| --- | --- | --- |
| A 草稿混入 B，离开页面丢失 | 实例＋会话键隔离；标签页 sessionStorage；提交版本确认，失败不覆盖新输入 | 单测；Web A/B 切换、配置页往返、刷新 |
| 默认 cwd 变化后旧会话被阻止打开 | 默认仅作用于新会话；历史使用自身 cwd 和权限，缺失目录明确报错 | 模拟 RPC 单测；真实 Pi A/B 项目和权限回读 |
| 500 条索引截断隐藏旧 JSONL | 完整索引；合法会话头重建遗漏入口；搜索、每批 100 条展示 | 502 条索引回归；非法文件不导入；Web 搜索 |
| 追问覆盖标题 | 仅首条消息生成默认标题 | 单测；真实 Pi 多轮及重启回读 |
| 短暂断网后轮询直接停止 | 最多 6 次指数退避，恢复先回读状态，不自动重发 prompt | 重试/失效会话策略单测；事件游标及快照测试 |
| 后台审批不可见、进程额度缺少释放入口 | 会话状态/后台审批定位提示；关闭指定会话进程，保留历史 | Web 审批跨会话定位；生命周期回归 |
| 任意 latest 升级只有版本号探测 | 限定验证版本；三平台 CI 和发布门禁实际启动固定 Pi，使用本地模拟 Provider 验收 | 版本限制及回滚单测；真实 RPC smoke |

旧索引未保存工具授权的会话按只读恢复；不从当前默认配置推断或扩大旧授权。目录是项目边界，不是操作系统沙箱。

关键实现：[运行时](../scripts/pi-runtime.js)、[工作台](../src/engines/pi/pages/workspace.js)、[草稿与重试](../src/engines/pi/lib/workspace-state.js)、[会话状态](../src/engines/pi/lib/session-state.js)。

## 已接入与仍待对标的操作

| 操作 | 当前状态 | 后续路径 |
| --- | --- | --- |
| 安装、更新、卸载、诊断 | 已接入；固定验证版本，切换失败回滚，卸载保留数据 | 安装进度和用户指定回退入口 |
| 模型渠道、会话选择模型 | 已接入；元数据回读，不固定 50000 上下文 | 真实多协议 Provider 验收 |
| 新建、恢复、搜索、关闭进程 | 已接入；实例草稿、绑定项目、后台审批提醒 | 原生改名、归档及列表服务端分页 |
| 流式回复、停止、基础问答审批 | 已接入；最终消息覆盖增量，四类 RPC 对话 | 更完整通知/状态/小组件，处理失效和超时 |
| 思考档位 | 可显示思考内容，无档位控件 | 能力探测＋set_thinking_level |
| 运行中补充指令或排队 | 未开放；忙碌时禁止普通发送 | steer/follow_up/clear_queue，区分接受、排队与执行 |
| 图片和附件 | 模型可声明 image，输入仍为文本 | MIME/大小校验及模型能力门控 |
| 用量、压缩、导出和分支 | 未开放 | get_session_stats/compact/export_html/fork/get_tree |
| 项目文件、编辑与 diff | 工具可操作，工作台无文件树/diff | 受信任目录只读视图、变更与审批关联 |
| Skills/MCP/项目自动上下文 | 启动时关闭自动加载 | 显式受信任资源配置、加载提示及逐次权限规则 |

长历史仍使用当前上下文快照和 80ms 节流的整页渲染，不宣称压缩前完整历史归档或千条消息性能达标。后续需持久条目读取、历史分页/窗口化、增量 DOM 和滚动锚点测量。

微信/飞书等渠道、Gateway 路由、设备节点、定时任务、长期记忆与多 Agent 调度属于独立服务能力；不因 Pi 编码 RPC 可用就显示这些能力已实现。

## 验证与持续门禁

- Windows 本地：全量 Node 回归、前端构建、Rust 格式/编译/单测/Clippy。
- 真实 Pi 1.1.0＋本地 OpenAI 兼容 SSE Provider：Unicode 和流式完整性、模型切换、审批拒绝/允许、取消、历史恢复、项目 cwd 与权限隔离、稳定标题。
- Web 生产构建：登录、草稿跨会话隔离、配置页往返及刷新恢复、后台审批定位、搜索和会话进程管理；桌面宽屏与移动布局检查。
- 三平台 CI 和发布前门禁执行 `node scripts/test-pi-runtime.mjs`。工作流配置见 [CI](../.github/workflows/ci.yml) 与 [发布](../.github/workflows/release.yml)；以对应提交的 GitHub Actions 实际结论为准。

真实 Pi 测试使用本地模拟模型，不调用收费服务。配置回读和模拟调用分别验收，不混为真实 Provider 已兼容。Tauri 私有桥由 Node/Rust 测试覆盖，Tauri GUI 全流程、Linux/macOS/ARM64 真机、真实 Responses/Anthropic/Google/Ollama 调用、长历史性能和复杂扩展仍待验收。

## 后续实施顺序

1. 能力驱动的会话改名/归档/复制及过程状态，补短断网浏览器故障注入和长历史测量。
2. 思考档位、原生队列、附件、统计/压缩、导出/分支、文件树/diff，逐项独立验收。
3. 受信任 Skills/MCP/上下文资源，多 Provider 与 Tauri GUI 真机矩阵。

共享视觉组件和模型渠道，不共享 OpenClaw Gateway 状态机，也不在这轮重写 OpenClaw 聊天模块。

## 官方参考

- [OpenClaw Control UI 功能参考](https://docs.openclaw.ai/web/control-ui/feature-reference)
- [OpenClaw 会话和侧边栏](https://docs.openclaw.ai/web/control-ui/sessions-and-sidebar)
- [Pi 1.1.0 RPC 生命周期](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc.md)
- [Pi 1.1.0 命令参考](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc-commands.md)
- [Pi 1.1.0 扩展交互](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/rpc-extension-ui.md)
