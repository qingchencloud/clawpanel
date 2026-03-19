# Repository Maturity

## 本次发现的核心结构问题
- `src/pages/chat.js` 与 `src/pages/assistant.js` 体量过大，页面职责与业务规则耦合严重。
- `src/lib/tauri-api.js` 同时承担 transport、缓存、错误包装与部分页面依赖入口，边界不够清晰。
- `scripts/dev-api.js` 过于庞大，路由、中间件、配置、命令逻辑混杂。
- UI 层直接理解较多后端响应细节，adapter/view-model 边界不足。
- chat/high-frequency 页面存在状态机复杂、时序敏感、体验问题容易反复出现的风险。

## 已完成改造项
- 新增 `src/lib/hosted-agent.js`，抽离 hosted Agent 常量、提示词、解析逻辑、动作文案。
- `src/pages/chat.js` 改为消费 hosted-agent 模块，降低页面内联业务规则密度。
- 删除 chat 自动滚动并禁用 chat 虚拟滚动，去掉隐式滚动接管链。
- 统一 hosted 状态文案、系统提示持久化与状态展示反馈。
- 新增 `src/lib/history-domain.js`，抽离 history payload 归一化、history hash、entry key、最大时间戳等纯领域规则。
- `src/pages/chat.js` 改为消费 history-domain 模块，开始把历史处理从页面层往 domain 层迁移。
- 新增 `src/lib/history-view-model.js`，统一用户图片附件转换、hosted seed 转换、本地历史图片映射、history 持久化消息映射。
- `chat.js` 中 apply/render 路径开始复用 history-view-model helper，页面层重复转换逻辑继续收缩。
- 新增 `src/lib/history-render-service.js`，抽离 history 渲染循环、增量渲染去重路径、omitted-images notice 插入。
- `applyHistoryResult(...)` 与 `applyIncrementalHistoryResult(...)` 开始复用 render-service，history 主流程已不再完全内联在页面文件中。
- 新增 `src/lib/history-loader-service.js`，抽离 pending payload 消费判定与本地历史回填逻辑。
- `flushPendingHistory(...)` 与 `loadHistory(...)` 开始复用 loader helper，history loader 路径继续从页面层剥离。
- 新增 `src/lib/history-apply-service.js`，抽离 history apply 前的 state 更新、hash 判重与 hosted seed 初始化。
- `applyHistoryResult(...)` 开始复用 apply-service，history apply 路径继续摆脱页面内联状态判断。
- 新增 `src/lib/hosted-runtime-service.js`，抽离 hosted runtime 的断线暂停、重连恢复、目标哈希与自动触发前状态切换。
- `pauseHostedForDisconnect(...)`、`resumeHostedFromReconnect(...)`、`maybeTriggerHostedRun(...)` 开始复用 hosted runtime helper，hosted 状态机从页面层继续剥离。
- 新增 `src/lib/hosted-history-service.js`，抽离 hosted target 捕获、history entry 写入、message 构建与 remote seed 映射。
- `shouldCaptureHostedTarget(...)`、`pushHostedHistoryEntry(...)`、`buildHostedMessages(...)`、`ensureHostedHistorySeeded(...)` 开始复用 hosted history helper，hosted history 路径持续脱离页面文件。
- 新增 `src/lib/hosted-step-service.js`，抽离 hosted step 的启动校验、开始运行、模板错误、成功收尾、自停与失败重试状态切换。
- `runHostedAgentStep(...)` 开始复用 hosted step helper，hosted execution/orchestration 继续从页面层剥离。
- 新增 `src/lib/hosted-output-service.js`，抽离 hosted 输出解析、instruction 去重发送前准备与 optimistic user reply 构造。
- `appendHostedOutput(...)` 与 `commitHostedUserReply(...)` 开始复用 hosted output helper，hosted 与 UI/消息发送的交互层继续从页面文件中抽离。
- 新增 `src/lib/hosted-session-service.js`，抽离 hosted session storage 读写、state 构建与 globals 快照逻辑。
- `saveHostedSessionConfigForKey(...)`、`buildHostedStateFromStorage(...)`、`withHostedState(...)`、`withHostedStateAsync(...)` 开始复用 hosted session helper，多 session hosted 状态管理继续从页面层剥离。
- 新增 `src/lib/hosted-orchestrator-service.js`，抽离 hosted remote seed 覆盖判定、cross-session 运行模式判断与 boundSessionKey 对齐逻辑。
- `ensureHostedHistorySeeded(...)` 与 `runHostedAgentStepForSession(...)` 开始复用 orchestrator helper，hosted 调度链继续摆脱页面文件内联编排。
- 新增 `src/lib/assistant-api-meta.js`，抽离 assistant API 类型归一化、鉴权要求、提示文案与输入占位元数据。
- `assistant.js` 开始复用 assistant API meta helper，assistant 领域的第一块独立边界已经建立。
- 新增 `src/lib/assistant-api-client.js`，抽离 assistant API base URL 规整、鉴权头构造与重试请求逻辑。
- `assistant.js` 开始复用 assistant API client helper，assistant 页与 API client 基础细节开始解耦。
- 新增 `src/lib/assistant-session-store.js`，抽离 assistant 配置读写、session 存储读写、序列化裁剪、会话创建与自动标题规则。
- `assistant.js` 开始复用 assistant session store helper，assistant 页与 config/session store 基础逻辑开始解耦。
- 新增 `src/lib/assistant-request-state.js`，抽离 assistant 请求生命周期状态、abort controller、queue 与 requestId 管理。
- `assistant.js` 开始复用 assistant request state helper，assistant 运行态管理开始从页面层剥离。
- 新增 `src/lib/assistant-attachments.js`，抽离 assistant 附件记录构造、preview HTML、pendingImages 增删清空与多模态消息 content 拼装。
- `assistant.js` 开始复用 assistant attachments helper，assistant 输入区附件逻辑开始从页面层剥离。
- 新增 `src/lib/assistant-tool-safety.js`，抽离 assistant 工具危险级别判定、关键命令检测与确认文案生成逻辑。
- `assistant.js` 开始复用 assistant tool safety helper，assistant 工具确认与安全围栏规则开始从页面层剥离。
- 新增 `src/lib/assistant-tool-ui.js`，抽离 ask_user 卡片 HTML、回答解析、已回答态渲染与工具块 HTML 生成逻辑。
- `assistant.js` 开始复用 assistant tool ui helper，assistant 的 ask_user 交互卡片与 tool progress 渲染开始从页面层剥离。
- 新增 `src/lib/assistant-tool-orchestrator.js`，抽离 tool history entry 构造/收尾与等待态包装逻辑。
- `callAIWithTools(...)` 开始复用 assistant tool orchestrator helper，assistant 的 tool 调度编排开始从页面层剥离。
- 新增 `src/lib/assistant-provider-adapters.js`，抽离多 provider API 调用、SSE 读取与工具定义格式转换逻辑。
- `assistant.js` 开始复用 assistant provider adapters helper，assistant 的 provider-specific 调用入口开始从页面层剥离。
- 新增 `src/lib/assistant-message-pipeline.js`，抽离用户消息构造、AI 占位消息、请求上下文初始化与重试条 HTML。
- `assistant.js` 开始复用 assistant message pipeline helper，assistant 主发送流程的基础拼装开始从页面层剥离。
- 新增 `src/lib/assistant-streaming-service.js`，抽离 tool progress 渲染、流式 chunk 更新与最终 bubble 收尾逻辑。
- `assistant.js` 开始复用 assistant streaming service helper，assistant 发送 / 重试流程中的重复流式渲染逻辑开始从页面层剥离。
- 新增 `src/lib/assistant-request-lifecycle.js`，抽离 retry bar 挂载与请求 finally 收尾逻辑。
- `assistant.js` 开始复用 assistant request lifecycle helper，assistant 发送 / 重试流程中的错误恢复与最终清理逻辑开始从页面层剥离。
- 新增 `src/lib/assistant-response-runner.js`，抽离 tool 模式与普通流式模式的响应执行主体。
- `assistant.js` 开始复用 assistant response runner helper，assistant send / retry 两条主路径中的重复响应执行逻辑开始从页面层剥离。
- 新增 `src/lib/assistant-run-context.js`，抽离响应启动前的按钮状态、首帧 typing UI 与工具模式判定。
- `assistant.js` 开始复用 assistant run context helper，assistant send / retry 两条主路径中的重复启动壳开始从页面层剥离。
- 第一批关键体验修复已开始落地：assistant 设置入口按钮改为明确“助手设置”语义并提升点击优先级，assistant 流式输出 / 工具进度 / 后台刷新改为 near-bottom 自动跟随策略。
- `chat.js` 开始修正心跳历史刷新与托管绑定兜底：`scrollToBottom(...)` 改为 near-bottom 策略，Hosted 绑定会话解析优先参考已启用的托管会话，降低切换会话后的错投概率。

## 后续建议
- 继续拆 `src/pages/chat.js`：history/domain、hosted runtime/service、session event adapter。
- 继续拆 `src/pages/assistant.js`：配置表单、状态机、工具调用、渲染层。
- 为 `tauri-api.js` 增加 adapter/view-model 边界，减少页面直接消费 command 细节。
- 分阶段拆 `scripts/dev-api.js`，优先 route dispatch 与 command handler 分离。
- 补 lint / 类型检查或等价静态校验，治理 Vite import warning。

## 约定的代码治理原则
- 页面层只负责页面装配与交互编排。
- 纯业务规则、提示词模板、解析逻辑优先抽到 `src/lib/`。
- UI 不直接耦合底层后端 DTO，优先通过 adapter/view-model 消费。
- 能删复杂逻辑就删，不为保留复杂实现而牺牲稳定性。
- 巨型文件优先按“常量/纯函数/状态转换”顺序渐进拆分，避免一次性大重构。
