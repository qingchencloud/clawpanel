# Cron SessionMessage + Tool UI Design

日期：2026-03-16

## 目标
- 在 ClawPanel 中新增 cron 任务类型：向指定 session 发送 user 消息
- 支持等待对话结束（Gateway WebSocket 事件）再发送
- Chat 页面展示工具调用（默认收起）
- 适配 npm 全局安装 OpenClaw（补丁应用与更新重打）

## 范围
- 新增 payload.kind = sessionMessage（Gateway cron 执行分支）
- ClawPanel cron UI 增加任务类型与字段
- Chat UI 增加 tool call 展示
- OpenClaw 版本更新时补丁自动重打

## 方案概述
### Cron SessionMessage
- payload.kind: sessionMessage
- 字段：label, message, role=user, waitForIdle=true
- Gateway cron 执行：label -> sessionKey -> 等待 chat final -> 发送 user 消息

### UI 改动
- cron 表单新增任务类型选择
- session label 下拉（来自 sessions.list）
- message 文本输入
- 列表与详情展示任务类型与目标

### Chat 工具调用展示
- 解析 message.content 中 tool / tool_result
- 默认收起，仅显示工具名与状态
- 点击展开显示参数与结果 JSON

### 补丁与更新
- 定位 npm 全局包路径（npm root -g + 包名）
- 打补丁前备份原文件
- 写入 clawpanel.json 记录补丁版本与 OpenClaw 版本
- 更新后检测版本变化并重打补丁

## 数据流
- Cron UI -> Gateway cron.add -> payload sessionMessage
- Gateway cron -> 监听 chat final -> chat.send (role=user)
- Chat UI -> 渲染 tool call blocks

## 错误处理
- label 不存在：任务失败并记录错误
- Gateway 未连接：cron UI 提示不可用
- 补丁失败：自动回退并提示

## 测试要点
- cron 创建/编辑/删除
- sessionMessage 执行成功
- 等待对话结束后发送
- tool call 展示与展开
- 补丁重打与回退
