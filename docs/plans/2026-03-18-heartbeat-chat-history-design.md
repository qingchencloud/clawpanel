# Heartbeat Chat History Refresh Design

日期: 2026-03-18

## 目标
- 每次 node.list 心跳发送时，同时触发 chat.history 刷新消息

## 范围
- src/lib/ws-client.js（心跳发送逻辑）

## 方案
- 在心跳定时器中，node.list 请求后追加 chat.history 请求
- 使用当前 sessionKey（与聊天页一致）
- 保持失败可忽略，不影响心跳继续

## 验证
- npm run build
- 观察 ws 发送帧同时包含 node.list + chat.history
