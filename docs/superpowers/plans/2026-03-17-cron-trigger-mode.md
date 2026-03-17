# Cron 触发模式扩展 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 sessionMessage 任务支持两种触发模式：按 cron 执行或监听指定会话 agent 任务结束后发送。

**Architecture:** 在 cron.js 中为 sessionMessage 任务增加触发模式字段（cron | onIdle），本地存储与渲染读取该字段；onIdle 模式基于 wsClient 事件跟踪目标会话的 run 状态，任务结束且空闲即发送；cron 模式保留现有定时器。非 sessionMessage 任务仍走 Gateway。

**Tech Stack:** ClawPanel (Vite + JS), WebSocket client, Tauri panel config API

---

## Chunk 1: 数据模型与 UI

### Task 1: 增加触发模式字段

**Files:**
- Modify: `src/pages/cron.js`

- [ ] **Step 1: 新增字段**

为 sessionMessage 本地任务新增 `triggerMode` 字段：`cron` | `onIdle`。

- [ ] **Step 2: UI 选择**

在 sessionMessage 任务编辑弹窗加入触发模式选择：
- 选项：`按 Cron` / `监听任务结束`
- 选择 onIdle 时隐藏 cron 输入，显示说明：监听目标会话任务结束后发送。

- [ ] **Step 3: 列表展示**

列表中显示触发模式：
- cron 显示 cron 文本
- onIdle 显示 “任务结束后发送”

- [ ] **Step 4: Commit**

```bash
git add src/pages/cron.js
git commit -m "feat: add sessionMessage trigger mode"
```

## Chunk 2: 触发逻辑

### Task 2: cron 与 onIdle 双模式发送

**Files:**
- Modify: `src/pages/cron.js`

- [ ] **Step 1: cron 触发**

仅当 `triggerMode === 'cron'` 时参与 `tickSessionMessageJobs` 逻辑。

- [ ] **Step 2: onIdle 触发**

新增 `checkIdleTrigger(job)`：
- 若 `triggerMode === 'onIdle'`，当目标会话从 active -> idle 且当前未发送过本轮，发送消息并记录 `lastRunAtMs`。

- [ ] **Step 3: 去重**

使用 `state.lastRunAtMs` 或 `state.lastIdleAtMs` 避免重复发送。

- [ ] **Step 4: Commit**

```bash
git add src/pages/cron.js
git commit -m "feat: onIdle trigger for sessionMessage"
```

## Chunk 3: 验证

### Task 3: Build 与手动验证

- [ ] **Step 1: Build**

```bash
npm run build
```

- [ ] **Step 2: 验证**

- 新建 sessionMessage 任务，选择 cron → 定时发送生效
- 新建 sessionMessage 任务，选择 onIdle → 会话任务结束后发送
- 非 sessionMessage 任务仍通过 Gateway 保存/触发

---
