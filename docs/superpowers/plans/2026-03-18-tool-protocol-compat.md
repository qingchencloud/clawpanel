# Tool Protocol Compatibility Implementation Plan

日期: 2026-03-18

## 目标
- 补齐 tool_use_id / result_id 等字段兼容
- 兼容 payload 结构变体（tool_use/tool_call/tool_result）
- 保持现有 UI 和渲染逻辑不变

## 变更范围
- src/pages/chat.js
  - extractChatContent
  - extractContent
  - collectToolsFromMessage

## 实施步骤
1. 建立检查点提交（code 修改前）
2. extractChatContent:
   - callId/resId 增加 tool_use_id / toolUseId / result_id / resultId
   - input/output 增加 meta?.input/meta?.output 兜底
3. extractContent:
   - callId/resId 同步上述字段
   - tool block input/output 同步兜底
4. collectToolsFromMessage:
   - tool_calls: id 增加 tool_use_id/toolUseId
   - tool_results: id 增加 result_id/resultId
   - input/output 兜底字段一致化
5. npm run build 验证
6. 提交并推送

## 验证清单
- 工具调用正常显示
- tool_result 可正确合并
- 无异常报错
