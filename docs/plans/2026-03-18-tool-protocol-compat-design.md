# Tool Protocol Compatibility Design

日期: 2026-03-18

## 目标与范围
- 覆盖常见变体：tool_use / tool_call / tool_result 等 block 结构
- 兼容字段别名：tool_use_id / toolUseId / result_id / resultId 等
- 统一输入输出字段映射，减少工具不显示或错合并
- 不改 UI 交互与渲染逻辑，仅增强协议兼容

## 方案选择
**推荐方案 1（轻量扩展）**
- 兼容字段别名 + payload 结构变体
- 仅修改：extractChatContent / extractContent / collectToolsFromMessage
- 风险低、改动集中、回归成本小

## 数据映射规则
- id 优先级：
  - id > tool_call_id > toolCallId > tool_use_id > toolUseId > result_id > resultId
- name 优先级：
  - name > tool > tool_name > toolName
- input 优先级：
  - input > args > parameters > arguments > meta?.input
- output 优先级：
  - output > result > content > meta?.output
- 贯穿字段：runId、messageTimestamp

## 兼容点
- extractChatContent: block 级 tool_call/tool_result
- extractContent: msg.content 数组中的 tool_call/tool_result
- collectToolsFromMessage: tool_calls / tool_results 结构

## 错误处理
- 缺少 id 时降级为 name + messageTimestamp 合并（已有策略）
- input/output 非字符串保持原样，渲染前做安全处理

## 验证
- 构建验证：npm run build
- 回归点：工具列表显示、工具输出合并、流式 tool 事件

## 非目标
- 不引入新的 UI 组件
- 不更改既有渲染布局与样式
