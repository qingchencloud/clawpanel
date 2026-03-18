# Chat Daylight Shadow Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a light-mode shadow to assistant message bubbles so they remain visible against the page background.

**Architecture:** Update chat CSS to apply a light-mode-only shadow on `.msg-ai .msg-bubble` without changing dark mode. No layout or markup changes.

**Tech Stack:** CSS, Vite build

---

## Chunk 1: Daylight shadow style

### Task 1: Add light-mode shadow for assistant bubbles

**Files:**
- Modify: `src/style/chat.css` (near `.msg-ai .msg-bubble` rules)

- [ ] **Step 1: Add light-mode CSS rule**

Add a new rule scoped to light theme:

```css
[data-theme="light"] .msg-ai .msg-bubble {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Build succeeds without errors.

- [ ] **Step 3: Commit**

```bash
git add src/style/chat.css
git commit -m "fix: add daylight shadow for ai bubble"
```

- [ ] **Step 4: Push**

```bash
git push
```
