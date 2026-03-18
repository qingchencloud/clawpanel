# Tool Variants + WS State Cleanup Design

日期: 2026-03-18

## 目标与范围
- 工具协议兼容扩展：补充 name/input/output 字段别名与 payload 变体
- ws-client 状态收敛：统一使用 _transition 进行状态变更

## 方案与数据映射
- tool name 优先级：
  - name > tool > tool_name > toolName > tool?.name > meta?.toolName
- tool input 优先级：
  - input > args > parameters > arguments > tool_input > meta?.input > meta?.args
- tool output 优先级：
  - output > result > content > tool_output > result_text > output_text > meta?.output
- runId/messageTimestamp 贯穿传递，降低误合并风险
- ws-client：查找并替换散落 state 赋值为 _transition 调用

## 兼容点
- src/pages/chat.js
  - extractChatContent
  - extractContent
  - collectToolsFromMessage
- src/lib/ws-client.js
  - 所有状态变更路径

## 错误处理
- 缺少 id 时降级为 name + messageTimestamp 合并
- 非字符串 input/output 保留原样，渲染前进行安全处理

## 验证
- npm run build
- 工具列表显示与 tool_result 合并
- ws-client 状态日志仅在 WS_DEBUG 开启时输出

## 非目标
- 不修改 UI 结构与样式
- 不引入新的组件或事件协议
