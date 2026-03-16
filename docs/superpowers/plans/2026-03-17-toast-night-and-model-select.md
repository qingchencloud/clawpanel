# Toast Night Style + Model Select Width Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve toast visibility in dark mode and make chat-model-select auto-size without truncation.

**Architecture:** Update CSS rules in `components.css` for toast dark mode and in `chat.css` for model select width.

**Tech Stack:** CSS, Vite build

---

## Chunk 1: Toast dark mode visibility

### Task 1: Add dark theme toast background

**Files:**
- Modify: `src/style/components.css`

- [ ] **Step 0: Checkpoint（PowerShell）**

```powershell
git status -sb
git commit --allow-empty -m "chore: checkpoint before toast dark style"
```

Note: This checkpoint is mandatory by policy before any modification. The final functional commit still occurs after build to honor Build First, Commit Later for real changes.

- [ ] **Step 1: Add dark theme override**

```css
[data-theme="dark"] .toast {
  background: var(--bg-secondary);
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Build succeeds without errors.

- [ ] **Step 3: Commit（PowerShell）**

```powershell
git add src/style/components.css
git commit -m "fix: improve toast dark mode"
```

- [ ] **Step 4: Push（PowerShell）**

```powershell
git push
```

## Chunk 2: Model select auto width

### Task 2: Remove truncation and allow auto width

**Files:**
- Modify: `src/style/chat.css`

- [ ] **Step 0: Checkpoint（PowerShell）**

```powershell
git status -sb
git commit --allow-empty -m "chore: checkpoint before model select width"
```

- [ ] **Step 1: Update model select styles**

Set the model select to auto width and remove truncation. Example:

```css
.chat-model-select {
  width: auto;
  max-width: none;
  white-space: nowrap;
}
```

Adjust if selectors differ in current file.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Build succeeds without errors.

- [ ] **Step 3: Commit（PowerShell）**

```powershell
git add src/style/chat.css
git commit -m "fix: auto width for chat model select"
```

- [ ] **Step 4: Push（PowerShell）**

```powershell
git push
```
