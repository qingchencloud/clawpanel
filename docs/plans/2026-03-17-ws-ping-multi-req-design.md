# WS Ping 多请求设计

## 目标
- 每次心跳发送 4 个 req：node.list / models.list / sessions.list / chat.history
- 保持连接存活并同步关键状态

## 现状
- 心跳仅发送 node.list

## 方案
- 在 `_startPing` 中按顺序发送 4 个 req
- 复用现有 `uuid()` 生成 id
- sessions.list 参数：`includeGlobal: true`, `includeUnknown: true`
- chat.history 参数固定 `sessionKey: agent:full-stack-architect:main`, `limit: 200`

## 设计细节
- 帧格式统一：`{ type: "req", id, method, params }`
- 在同一计时周期内连续发送 4 条 req

## 风险
- 请求频率增加，可能带来负载波动
- 若 Gateway 限流，需要再降频

## 验收标准
- 每个周期触发 4 条 req
- 控制台无异常
- Gateway 正常返回
