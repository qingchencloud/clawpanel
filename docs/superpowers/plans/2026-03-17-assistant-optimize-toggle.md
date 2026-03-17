# 优化/还原按钮切换 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化与还原按钮互斥显示，默认显示“优化”，优化后显示“还原”，发送或还原后切回“优化”。

**Architecture:** 根据 `_optOriginalText` 状态控制按钮显隐与禁用。

**Tech Stack:** Vanilla JS

---

## Chunk 1: 逻辑调整

### Task 1: updateOptimizeState 互斥显示
**Files:**
- Modify: `src/pages/assistant.js`

- [ ] **Step 1: 更新 updateOptimizeState**
  
逻辑：
- `_optOriginalText` 为 null → 显示优化按钮，隐藏还原按钮  
- `_optOriginalText` 非空 → 隐藏优化按钮，显示还原按钮  

- [ ] **Step 2: 按钮点击后切换**
  
- 优化完成 → 切到还原  
- 点击还原 → 清空快照并切回优化  
- 发送 → 清空快照并切回优化  

- [ ] **Step 3: 提交**
```bash
git add src/pages/assistant.js
git commit -m "fix: toggle optimize and restore buttons"
```

---

## Chunk 2: 构建与推送

### Task 2: 构建
**Files:** 无

- [ ] **Step 1: 构建**
```bash
npm run build
```

- [ ] **Step 2: 推送**
```bash
git push
```
