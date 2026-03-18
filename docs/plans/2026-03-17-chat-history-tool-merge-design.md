# 聊天历史工具卡片合并与排序设计

## 目标
- 历史记录解析后，工具卡片只显示 1 份（按 toolCallId 合并）
- 工具卡片显示在消息气泡上方
- 工具时间优先使用事件 ts，缺失回退 message.timestamp
- 历史模式不再插入工具事件系统消息
- 历史列表按时间排序，同时间工具在上文本在下

## 现状问题
- history 刷新后出现重复工具卡片（toolCall/toolResult 未合并）
- 工具时间缺失导致排序异常
- 工具事件系统消息与工具卡片同时出现，导致页面被工具卡片占满

## 方案（合并式解析）
1) 统一合并：工具块解析使用 upsertTool，按 toolCallId 合并
2) 时间回退：工具时间 = eventTs || message.timestamp || null
3) 历史禁入系统消息：history 解析不再插入工具事件系统消息
4) 排序规则：按 time 升序；相同时间时工具卡片在上，文本在下

## 设计细节
- 新增工具时间解析函数：`resolveToolTime(toolId, messageTimestamp)`
- 工具事件处理处增加 history 标记，历史模式不调用 `appendSystemMessage`
- 渲染时将工具卡片与文本作为 entries 统一排序

## 验收标准
- 历史记录中工具卡片不重复
- 刷新后工具时间可见
- 工具卡片位于消息气泡上方
- 列表不再被工具事件系统消息淹没
