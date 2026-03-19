# Repository Maturity Plan

## 当前问题总览

### 技术栈与结构现状
- 前端：Vanilla JS + Vite，页面集中在 `src/pages`
- 桌面端：Tauri v2，Rust 命令在 `src-tauri/src`
- Web/Headless 适配：`scripts/dev-api.js` + `scripts/serve.js`
- 测试：Vitest（存在测试，但无 lint、无类型检查脚本）
- 包管理：npm + package-lock

### 审计结论摘要
1. **页面文件过大**
   - `src/pages/chat.js` 仍是最大热点文件，承担路由页、状态机、托管 Agent、历史处理、会话管理、消息渲染、输入锁定等多重职责。
   - `src/pages/assistant.js` 同样偏大，页面状态、交互、配置管理混杂。
2. **前后端边界不够清晰**
   - `src/lib/tauri-api.js` 既承担命令调用、缓存、Web fallback，又让页面直接理解后端命令名。
   - `scripts/dev-api.js` 体量很大，既做 API 中间件，又做业务逻辑、配置读写、命令执行与适配。
3. **页面层承担过多业务逻辑**
   - `chat.js` 中存在大量 DTO 解析、history 去重、hosted response 解析、状态转换逻辑。
   - UI 层直接关心 Gateway event payload 与消息结构细节。
4. **副作用散落**
   - 页面内直接读写 localStorage、调用 API、更新 DOM、持久化运行态，缺少统一 service / adapter 边界。
5. **性能与体验风险并存**
   - 大文件导致维护成本高，回归风险高。
   - 页面层状态过多，调试困难。
   - 构建存在 Vite dynamic/static import warning。
   - chat / assistant 这类高频交互页面容易出现状态不同步、滚动、去重、重连边界问题。

## 目标架构原则
- **简洁**：少而清晰的模块边界，避免花哨分层。
- **模块化**：把可稳定复用的业务规则从页面剥离。
- **低耦合**：UI 只消费 view-model / service，不直接拼底层后端细节。
- **高可维护**：页面负责展示与交互编排，domain/service 负责规则，adapter 负责数据转换。
- **渐进式重构**：优先高收益低风险拆分，不做全量推倒。

## 推荐目录结构

```text
src/
  components/            # 通用 UI 组件
  lib/
    api/                 # API 调用封装（后续可迁移）
    adapters/            # 后端 DTO -> 前端 view model
    domain/              # 纯业务规则、状态转换、解析逻辑
    hosted-agent.js      # 已落地的第一步：托管 Agent 常量/解析/提示词
  pages/
    chat.js              # 页面装配层，继续瘦身
    assistant.js         # 页面装配层，继续瘦身
  style/
    ...

src-tauri/
  src/
    commands/            # Rust command handlers
    models/              # Rust DTO / types
    utils.rs             # 基础工具

scripts/
  dev-api.js             # Web/headless API bridge（后续建议拆分）
  serve.js               # headless server 启动入口
```

## 前后端解耦策略
1. **页面不直接解释后端原始响应**
   - 新增 adapter/domain 层，负责把 Gateway/Tauri/dev-api 返回结构转换成页面需要的数据。
2. **`tauri-api.js` 逐步变成 transport 层**
   - 只负责请求、缓存、错误包装，不承担页面业务判断。
3. **`dev-api.js` 分步拆分**
   - 拆成 route middleware + command handlers + config helpers，避免单文件承担全部头部逻辑。
4. **Hosted / chat / assistant 规则独立出页面**
   - 先抽纯函数与常量，再抽状态转换逻辑，最后再抽 service。

## 性能优化策略
1. 减少巨型页面文件中的重复逻辑与重复解析。
2. 统一消息/history/hosted 解析路径，降低重复计算。
3. 避免在 UI 层直接遍历和重组原始 payload。
4. 后续治理 Vite dynamic/static import warning，降低包体和 chunk 边界混乱。
5. 高风险页面（chat / assistant）优先做“逻辑抽离”，减少每次修改带来的全文件回归风险。

## 用户体验优化策略
1. 统一加载态、错误态、空态文案来源。
2. 统一 hosted 状态文案与系统气泡策略，避免不同区域说法不一致。
3. 页面内交互规则尽量单点定义，例如：锁定输入、暂停/恢复、错误恢复。
4. 不稳定体验问题优先用“删复杂逻辑”解决，而不是继续叠补丁。

## 分阶段实施计划

### P0（立即处理，高收益低风险）
- 拆出 `chat.js` 中纯业务规则：hosted constants、prompt、response parse、instruction extract、action label。
- 让 chat 页面不再承载所有 hosted 规则细节。
- 删除高维护成本且不稳定的自动滚动/虚拟滚动路径。
- 统一 hosted 状态文案与系统反馈。

### P1（下一阶段）
- 继续拆分 `chat.js`
  - history/domain
  - hosted runtime/service
  - session list / event adapter
- 拆分 `assistant.js` 中配置、状态、渲染、工具调用路径。
- 给 `tauri-api.js` 引入更清晰的 command adapter/view-model adapter。
- 为关键领域（chat / assistant / hosted）补充更有针对性的测试。

### P2（成熟化收尾）
- 拆分 `scripts/dev-api.js` 为更清晰的路由/处理器结构。
- 梳理 Rust command / JS adapter 的 DTO 边界。
- 补 lint、类型检查或等价静态校验流程。
- 治理 Vite chunk warning 与 import 边界。

## 已完成的第一阶段改造
1. 将托管 Agent 的核心常量、固定提示词、解析逻辑、动作文案抽离到：
   - `src/lib/hosted-agent.js`
2. `src/pages/chat.js` 改为消费 hosted-agent 模块，而不是继续内联所有 hosted 领域逻辑。
3. 彻底禁用 chat 页虚拟滚动，去掉其对滚动位置的隐式接管。
4. 统一 hosted 状态展示与系统反馈文案。
5. 新增 `src/lib/history-domain.js`，抽离 history payload 归一化、history hash、entry key、最大时间戳计算等纯规则。
6. `src/pages/chat.js` 开始消费 history-domain 模块，页面层继续向“渲染与编排”收口。
7. 新增 `src/lib/history-view-model.js`，统一 history 到 UI 的附件、持久化、hosted seed 等视图转换规则。
8. `applyHistoryResult(...)`、`applyIncrementalHistoryResult(...)` 与本地历史回填路径开始复用同一批 history view-model helper，减少页面内重复转换逻辑。
9. 新增 `src/lib/history-render-service.js`，把 full apply / incremental apply 的共用渲染循环抽成独立 service helper。
10. `chat.js` 中 history 渲染主流程开始通过 render-service 复用，页面层进一步收口到状态编排与依赖注入。
11. 新增 `src/lib/history-loader-service.js`，抽离 pending history flush 判定与本地历史回填逻辑。
12. `flushPendingHistory(...)` 与 `loadHistory(...)` 开始复用 loader helper，页面层继续减少重复分支与本地回填细节。
13. 新增 `src/lib/history-apply-service.js`，抽离 history apply 前的状态更新判断与 hosted seed 初始化逻辑。
14. `applyHistoryResult(...)` 开始复用 apply-service，页面层继续从“状态更新 + 渲染执行”向“编排 + 注入依赖”收口。
15. 新增 `src/lib/hosted-runtime-service.js`，抽离 hosted runtime 的断线暂停、重连恢复、目标哈希与自动触发前状态切换规则。
16. `pauseHostedForDisconnect(...)`、`resumeHostedFromReconnect(...)`、`maybeTriggerHostedRun(...)` 开始复用 hosted runtime helper，chat 页面内联状态机噪音继续下降。
17. 新增 `src/lib/hosted-history-service.js`，抽离 hosted target 捕获判定、history entry 写入、hosted message 构建与 remote seed 映射。
18. `shouldCaptureHostedTarget(...)`、`pushHostedHistoryEntry(...)`、`buildHostedMessages(...)`、`ensureHostedHistorySeeded(...)` 开始复用 hosted history helper，hosted 领域边界进一步清晰。
19. 新增 `src/lib/hosted-step-service.js`，抽离 hosted step 的启动校验、运行开始、模板错误、成功收尾、自停与失败重试状态切换。
20. `runHostedAgentStep(...)` 开始复用 hosted step helper，hosted orchestration 从页面内联状态机继续收缩为编排层。
21. 新增 `src/lib/hosted-output-service.js`，抽离 hosted 输出解析、instruction 去重发送前准备与 optimistic user reply 构造。
22. `appendHostedOutput(...)` 与 `commitHostedUserReply(...)` 开始复用 hosted output helper，hosted 与 chat UI 的交互边界进一步清晰。
23. 新增 `src/lib/hosted-session-service.js`，抽离 hosted session storage 读写、state 构建与 globals 快照逻辑。
24. `saveHostedSessionConfigForKey(...)`、`buildHostedStateFromStorage(...)`、`withHostedState(...)`、`withHostedStateAsync(...)` 开始复用 hosted session helper，多 session hosted 状态管理继续脱离页面文件。
25. 新增 `src/lib/hosted-orchestrator-service.js`，抽离 hosted remote seed 覆盖判定、cross-session 运行模式判断与 boundSessionKey 对齐逻辑。
26. `ensureHostedHistorySeeded(...)` 与 `runHostedAgentStepForSession(...)` 开始复用 orchestrator helper，hosted session/history/step 串联调度继续从页面中抽离。
27. 新增 `src/lib/assistant-api-meta.js`，抽离 assistant API 类型归一化、鉴权要求、提示文案与输入占位元数据。
28. `assistant.js` 开始复用 assistant API meta helper，页面层不再内联维护 API 类型说明与占位规则。
29. 新增 `src/lib/assistant-api-client.js`，抽离 assistant API base URL 规整、鉴权头构造与重试请求逻辑。
30. `assistant.js` 开始复用 assistant API client helper，assistant 页与底层 API 客户端细节进一步解耦。
31. 新增 `src/lib/assistant-session-store.js`，抽离 assistant 配置读写、session 存储读写、序列化裁剪、会话创建与自动标题规则。
32. `assistant.js` 开始复用 assistant session store helper，页面层继续从 config/session 存储细节中收口。
33. 新增 `src/lib/assistant-request-state.js`，抽离 assistant 请求生命周期状态、abort controller、queue 与 requestId 管理。
34. `assistant.js` 开始复用 assistant request state helper，流式请求与队列运行态开始从页面文件中剥离。
35. 新增 `src/lib/assistant-attachments.js`，抽离 assistant 附件记录构造、preview HTML、pendingImages 增删清空与多模态消息 content 拼装。
36. `assistant.js` 开始复用 assistant attachments helper，输入区附件逻辑开始从页面文件中收口。
37. 新增 `src/lib/assistant-tool-safety.js`，抽离 assistant 工具危险级别判定、关键命令检测与确认文案生成逻辑。
38. `assistant.js` 开始复用 assistant tool safety helper，工具确认与安全围栏规则开始从页面文件中剥离。
39. 新增 `src/lib/assistant-tool-ui.js`，抽离 ask_user 卡片 HTML、回答解析、已回答态渲染与工具块 HTML 生成逻辑。
40. `assistant.js` 开始复用 assistant tool ui helper，ask_user 交互卡片与 tool progress 渲染开始从页面文件中收口。
41. 新增 `src/lib/assistant-tool-orchestrator.js`，抽离 tool history entry 构造/收尾与等待态包装逻辑。
42. `callAIWithTools(...)` 开始复用 assistant tool orchestrator helper，tool 调度编排继续从页面文件中收口。
43. 新增 `src/lib/assistant-provider-adapters.js`，抽离多 provider API 调用、SSE 读取与工具定义格式转换逻辑。
44. `assistant.js` 开始复用 assistant provider adapters helper，provider-specific 调用入口继续从页面文件中剥离。
45. 新增 `src/lib/assistant-message-pipeline.js`，抽离用户消息构造、AI 占位消息、请求上下文初始化与重试条 HTML。
46. `assistant.js` 开始复用 assistant message pipeline helper，主发送流程的基础拼装开始从页面文件中收口。
47. 新增 `src/lib/assistant-streaming-service.js`，抽离 tool progress 渲染、流式 chunk 更新与最终 bubble 收尾逻辑。
48. `assistant.js` 开始复用 assistant streaming service helper，发送 / 重试流程中的重复流式渲染逻辑继续从页面文件中剥离。
49. 新增 `src/lib/assistant-request-lifecycle.js`，抽离 retry bar 挂载与请求 finally 收尾逻辑。
50. `assistant.js` 开始复用 assistant request lifecycle helper，发送 / 重试流程中的错误恢复与最终清理逻辑继续从页面文件中收口。
51. 新增 `src/lib/assistant-response-runner.js`，抽离 tool 模式与普通流式模式的响应执行主体。
52. `assistant.js` 开始复用 assistant response runner helper，send / retry 两条主路径中的重复响应执行逻辑继续从页面文件中剥离。
53. 新增 `src/lib/assistant-run-context.js`，抽离响应启动前的按钮状态、首帧 typing UI 与工具模式判定。
54. `assistant.js` 开始复用 assistant run context helper，send / retry 两条主路径中的重复启动壳继续从页面文件中剥离。
55. 第一批关键体验修复开始落地：`assistant.js` 设置入口按钮改为明确“助手设置”语义并提升点击优先级，流式/工具进度/后台刷新改为仅在接近底部时自动跟随。
56. `chat.js` 开始修正心跳历史刷新与托管绑定兜底：`scrollToBottom(...)` 改为 near-bottom 策略，Hosted 绑定会话优先基于已启用的托管会话解析。
57. Hosted Agent 管理 UI 开始从开关切换改为按钮式管理：移除“启用托管 Agent”开关文案，统一通过“启动托管 / 暂停 / 停止 / 保存配置”按钮管理。
58. `src/lib/hosted-agent.js` 的固定提示词改为简约指引风格，减少长篇规划和冗余输出，强调短句、执行导向和简明用户回复。
59. `chat.history` 刷新链路继续收紧：全量历史应用在已有消息时不再强制 `scrollToBottom(true)`，改为 only-on-first-load 策略，降低心跳刷新导致的异常滚动。
60. Hosted 错投链路继续修正：`createAskUserBubble(...)` 与 `commitHostedUserReply(...)` 默认优先使用 `getHostedBoundSessionKey()`，且非当前 UI 会话时不再把 optimistic 用户消息误插入当前会话 DOM。
61. `src/lib/hosted-agent.js` 的固定提示词模板已按用户提供版本替换为变量化 Role/Profile/Variables/Skills/Rules 结构，保留简洁执行导向并支持默认值回退语义。
62. Hosted Prompt 模板继续补完用户提供的 `Workflows` 与 `Initialization` 片段，固定四段输出结构与最小充分表达原则已一并写入模板主体。
63. 新增 `src/lib/skills-catalog.js` 作为 Skills 数据轻量缓存层，统一负责 `skillsList` 结果缓存、TTL、失效与摘要统计，减少 Dashboard / Skills 重复加载成本。
64. Dashboard 总览卡把 `MCP 工具` 正式切换为 `Skills`，显示真实 Skills 总数与可用/缺依赖摘要，不再读取 `readMcpConfig()` 作为该卡来源。
65. `src/pages/skills.js` 开始复用 skills catalog cache：优先渲染缓存结果、后台刷新；安装依赖 / 安装 Skill / 卸载 / 手动刷新时统一失效缓存并强制重载，提升打开速度并修正统计摘要包含 blocked 数量。
66. `src/components/sidebar.js` 新增分组折叠态记忆：各导航分组可单独展开/折叠，状态持久化到 localStorage，并保持桌面侧边栏整体折叠模式兼容。
67. Sidebar icon 收口一版：重做 `dashboard` / `services` / `skills` 图标，并为分组标题新增自定义 toggle 结构，避免原生按钮样式破坏整体 UI。
68. 公网访问分层表单主入口已确认在 `src/pages/settings.js` 的 `cloudflared` 区块；下一轮将围绕 `loadCloudflared(...)` / `handleCloudflaredStart(...)` 做表单分层与说明收口。
69. `src/pages/settings.js` 的 Cloudflared 公网访问表单已改为四层结构：状态卡、启动操作、暴露目标、隧道模式；保持原启动参数不变，只重构展示与交互层。
70. 新增 `syncCloudflaredFormState(...)`：切换 `cloudflared-mode` / `cloudflared-expose` / `cloudflared-port` 时，动态切换对应表单块可见性并实时更新实际端口展示。
71. Cloudflared 表单继续收紧交互边界：新增 `validateCloudflaredForm(...)`，命名隧道缺少隧道名/域名、自定义端口为空时禁止启动，并通过提示文案与按钮禁用态即时反馈。
72. `syncCloudflaredFormState(...)` 现同时负责输入禁用态：非自定义目标时禁用端口输入，非命名隧道时禁用隧道名/域名输入，降低误填和误启概率。
73. Cloudflared 操作按钮状态继续收紧：未安装时禁用登录与启动，安装按钮切为“已安装”只读态，并通过验证提示区明确引导“先安装再登录再启动”。
74. `loadCloudflared(...)` 现将安装状态挂到页面上下文，`syncCloudflaredFormState(...)` 统一处理安装态 + 校验态双重禁用逻辑，避免未安装时触发假动作。
75. Skills 页增加顶部统计卡：将总数、可用、待处理、已禁用四类状态前置，减少用户必须逐段滚动才能理解当前技能态势的成本。
76. Skills 过滤交互补空态：输入过滤关键字后若无任何匹配项，显示独立空态提示而非留白，增强页面收尾体验。
77. Cloudflared 状态卡继续前置安装信息：将“安装状态”从按钮语义中抽离成独立状态卡，并让登录 / 启动的未安装兜底同时保留在按钮逻辑层，提升设置页可读性与一致性。
78. Dashboard 的 Skills 卡片文案已与 Skills 页总览口径对齐：从“可用 / 缺依赖”升级为“可用 / 待处理 / 已禁用”，减少跨页理解落差。
79. 已开始保守式 upstream 同步：选择性吸收 `upstream/main` 的 `8485df7`（`src-tauri/src/commands/config.rs` clippy 清理），冲突后保留本地行为并仅手动吸收 `.flatten()` 迭代简化，避免整包 merge 冲乱当前分支大规模前端重构。
80. 已拆解 `7764a32` 并只吸收低风险高价值块：`src/lib/tauri-api.js` 中配置保存后的 3 秒防抖 Gateway 重载，以及 `src/lib/markdown.js` 中图片加载失败提示的反斜杠安全转义；`chat.js` / hosted / 样式重排等高风险块明确暂不手抄。

## 风险与回滚建议
- 风险：`chat.js` 仍然较大，后续继续拆分时容易影响事件时序。
- 风险：`dev-api.js` 仍是单点复杂模块，后续拆分需分批进行。
- 回滚策略：
  1. 每阶段重构前建 checkpoint commit
  2. 单主题提交，不混入无关样式或功能
  3. 每阶段都执行 `npm run build` 与 `npm test`
  4. 历史重写前始终先建 backup 分支
