# Toast Shadow Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a medium-strength shadow to toast cards while keeping the Vercel-style solid background.

**Architecture:** Modify `.toast` rule in `components.css` to add `box-shadow` only.

**Tech Stack:** CSS, Vite build

---

## Chunk 1: Toast shadow

### Task 1: Add toast shadow

**Files:**
- Modify: `src/style/components.css`

- [ ] **Step 0: Checkpoint（PowerShell）**

```powershell
git status -sb
git commit --allow-empty -m "chore: checkpoint before toast shadow"
```

Note: This checkpoint is required by policy to protect rollbacks. The final functional commit still happens after `npm run build`.

- [ ] **Step 1: Add box-shadow**

```css
.toast {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: Build succeeds without errors.
Note: This is the frontend Vite build; no `wails build` required for this CSS-only change.

- [ ] **Step 3: Commit（PowerShell）**

```powershell
git add src/style/components.css
git commit -m "fix: add toast shadow"
```

- [ ] **Step 4: Push（PowerShell）**

```powershell
git push
```
