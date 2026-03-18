# WS Ping 改为 node.list 设计

## 目标
- 将 WebSocket 心跳从 `{ "type":"ping" }` 改为 `req node.list`
- 保持连接存活并提供实时节点状态

## 方案
- 在 `_startPing` 中改为发送 `req` 帧
- 维持原有间隔

## 设计细节
- 帧格式：`{ type: "req", id: uuid(), method: "node.list", params: {} }`
- 仅替换 ping 发送内容

## 验收标准
- 连接稳定
- 控制台不报错
- node.list 有返回
