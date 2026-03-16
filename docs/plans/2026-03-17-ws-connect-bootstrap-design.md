# WS 连接后启动请求设计

## 目标
- 连接成功后一次性发送官方同款 8 个请求
- ping 间隔改为 5 秒
- 重连后也执行一次

## 官方请求清单
- agent.identity.get (sessionKey)
- agents.list
- health
- node.list
- device.pair.list
- chat.history (sessionKey, limit=200)
- sessions.list (includeGlobal/includeUnknown)
- models.list

## 方案
- 在 connect 成功处理函数中发送一组 req 帧
- 每次重连也触发
- ping 仍按 5 秒周期发送（保持已实现的多请求）

## 设计细节
- 新增 `_sendBootstrapRequests()`
- 使用 `uuid()` 生成 id
- sessionKey 使用当前会话 `this._sessionKey`

## 验收标准
- 每次连接成功后立即发送 8 个 req
- ping 间隔为 5 秒
- 控制台无异常
