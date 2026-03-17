# Assistant UX + Windows Shell 优化 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Windows shell 优先级、复制按钮样式统一、AI 助手输入区新增优化/恢复功能并保留撤销栈。

**Architecture:** 后端 assistant_exec 增加 shell 探测与降级；前端统一 code-copy-btn CSS；AI 助手输入区新增优化调用与快照管理。

**Tech Stack:** Rust (Tauri), Vanilla JS, CSS

---

## Chunk 1: Windows shell 优先级

### Task 1: assistant_exec 使用 pwsh 优先级
**Files:**
- Modify: `src-tauri/src/commands/assistant.rs`

- [ ] **Step 1: 增加 shell 探测函数**
  
在 Windows 分支增加一个 `detect_windows_shell()`：
- 依次检查 `pwsh`、`powershell`
- 都不可用则返回 `cmd`

实现方式：使用 `where` 探测，并使用 `build_system_env()` 注入完整环境。

- [ ] **Step 2: 替换执行逻辑**
  
`assistant_exec` 使用探测结果执行：
- pwsh / powershell：`-NoProfile -Command <command>`
- cmd：`/c <command>`

- [ ] **Step 3: 提交**
```bash
git add src-tauri/src/commands/assistant.rs
git commit -m "feat: prefer pwsh in assistant exec"
```

---

## Chunk 2: 复制按钮错位修复（CSS）

### Task 2: 统一 chat.css 与 assistant.css
**Files:**
- Modify: `src/style/chat.css`
- Modify: `src/style/assistant.css`

- [ ] **Step 1: 统一 pre 与 copy 按钮样式**
  
将 assistant.css 中 pre 样式改为与 chat.css 一致，确保：
- `.code-copy-btn` 右上角悬浮
- hover 才显示
- 不改 Markdown 解析逻辑

- [ ] **Step 2: 提交**
```bash
git add src/style/chat.css src/style/assistant.css
git commit -m "fix: align code copy button styles"
```

---

## Chunk 3: AI 优化按钮

### Task 3: 输入区新增优化/恢复按钮
**Files:**
- Modify: `src/pages/assistant.js`

- [ ] **Step 1: 增加按钮 DOM**
  
在输入区加入 “优化” 与 “恢复原文” 按钮。

- [ ] **Step 2: 维护快照状态**
  
新增变量：`_optOriginalText` / `_optOptimizedText`  
规则：
- 点击优化：保存原文快照，写入优化结果快照  
- 点击恢复：恢复原文  
- 发送成功后清空快照  

- [ ] **Step 3: 调用同模型在线重写**
  
复用现有模型调用逻辑：
- 模板：`请在不改变原意和语言的前提下，重写为意思更清晰、更简洁的表达。`
- 使用同模型
- 结果直接替换输入框内容

- [ ] **Step 4: setRangeText 触发 input 事件**
  
使用 `textarea.setRangeText()` + 触发 `input` 事件，保证 Ctrl+Z 生效。

- [ ] **Step 5: 提交**
```bash
git add src/pages/assistant.js
git commit -m "feat: add optimize and restore buttons"
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
- Windows 下执行命令优先 pwsh  
- 复制按钮位置正确  
- 优化/恢复可用且 Ctrl+Z 正常  

- [ ] **Step 3: 推送**
```bash
git push
```
