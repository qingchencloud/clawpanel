# Toast Vercel Style Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace glass/blur toast with solid Vercel-style card that adapts to light/dark themes.

**Architecture:** Update toast styles in `components.css` to remove blur, use theme variables for background and border, keep status text colors.

**Tech Stack:** CSS, Vite build

---

## Chunk 1: Toast style update

### Task 1: Update toast base style

**Files:**
- Modify: `src/style/components.css`

- [ ] **Step 0: Checkpoint**

```bash
git status -sb
git commit --allow-empty -m "chore: checkpoint before toast style update"
```

- [ ] **Step 1: Remove blur and set base card styles**

Update `.toast` rule:
- remove `backdrop-filter`
- add `background: var(--bg-primary);`
- add `border: 1px solid var(--border);`

- [ ] **Step 2: Simplify status variants**

Update `.toast.success/.error/.info/.warning` to only set `color`, removing background and border overrides.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: Build succeeds without errors.

- [ ] **Step 4: Commit**

```bash
git add src/style/components.css
git commit -m "fix: vercel-style toast card"
```

- [ ] **Step 5: Push**

```bash
git push
```
