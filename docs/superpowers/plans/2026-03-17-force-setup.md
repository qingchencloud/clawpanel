# forceSetup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 添加 `forceSetup` 开关，使构建版可强制进入 /setup，完成初始化后自动关闭。

**Architecture:** 在 panel config 中存储 forceSetup；启动时读取并强制跳转；setup 成功后清零。

**Tech Stack:** Vanilla JS, Tauri

---

## Chunk 1: 配置字段读写

### Task 1: panel config 增加 forceSetup
**Files:**
- Modify: `src-tauri/src/commands/config.rs`
- Modify: `src/lib/tauri-api.js`

- [ ] **Step 1: 扩展 panel config 读写**
  
在读写 panel config 时透传 `forceSetup`。

- [ ] **Step 2: 提交**
```bash
git add src-tauri/src/commands/config.rs src/lib/tauri-api.js
git commit -m "feat: add forceSetup to panel config"
```

---

## Chunk 2: 启动强制跳转

### Task 2: main.js 强制跳 setup
**Files:**
- Modify: `src/main.js`

- [ ] **Step 1: 启动时读取 panel config**
  
在 `ensureWebSession` 前读取 panel config，若 `forceSetup===true` 强制跳转 `/setup`。

- [ ] **Step 2: 提交**
```bash
git add src/main.js
git commit -m "feat: force setup on startup"
```

---

## Chunk 3: setup 完成后清零

### Task 3: setup.js 成功后清零
**Files:**
- Modify: `src/pages/setup.js`

- [ ] **Step 1: setup 成功时写入 forceSetup=false**

- [ ] **Step 2: 提交**
```bash
git add src/pages/setup.js
git commit -m "feat: clear forceSetup after setup"
```

---

## Chunk 4: 构建与验证

### Task 4: 构建
**Files:** 无

- [ ] **Step 1: 构建**
```bash
npm run build
```

- [ ] **Step 2: 手工验证**
- forceSetup=true 时进入 /setup  
- setup 完成后不再强制跳转  
- forceSetup=false 时逻辑不变  

- [ ] **Step 3: 推送**
```bash
git push
```
