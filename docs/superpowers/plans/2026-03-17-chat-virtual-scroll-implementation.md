# Chat Virtual Scroll Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement virtual scrolling for chat messages with fixed window size (40 + overscan 20), fast first paint, and stable scroll anchoring.

**Architecture:** Use a virtualized list with top/bottom spacers and total height based on cumulative measured heights (fallback to average). Range calculation uses cumulative heights (prefix sums + binary search) with a fixed window cap. Preserve anchor when not at bottom.

**Tech Stack:** JS, Vite

---

## File Map
- Modify: `src/pages/chat.js:64-2000` (virtual state, scroll handler, render path)
- Create: `src/lib/virtual-scroll.js` (range + prefix height helpers)
- Create: `tests/virtual-scroll.test.js`
- Modify: `package.json` (test script, devDependency)

---

## Chunk 1: Test scaffolding + helpers (TDD)

### Task 1: Add test tooling

**Files:**
- Modify: `package.json`

- [ ] **Step 0: Checkpoint（PowerShell）**

```powershell
git status -sb
git commit --allow-empty -m "chore: checkpoint before chat virtual scroll"
```

- [ ] **Step 1: Add dev dependency and script**

Add:
- `devDependencies.vitest`
- `scripts.test = "vitest run"`

- [ ] **Step 2: Install**

```powershell
npm install
```

### Task 2: Create helper module

**Files:**
- Create: `src/lib/virtual-scroll.js`

- [ ] **Step 1: Implement helpers**

```js
export function getItemHeight(items, idx, heights, avgHeight) {
  const id = items[idx]?.id
  return heights.get(id) || avgHeight
}

export function buildPrefixHeights(items, heights, avgHeight) {
  const prefix = [0]
  for (let i = 0; i < items.length; i++) {
    prefix[i + 1] = prefix[i] + getItemHeight(items, i, heights, avgHeight)
  }
  return prefix
}

export function findStartIndex(prefix, scrollTop) {
  let lo = 0, hi = prefix.length - 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (prefix[mid] <= scrollTop) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, lo - 1)
}

export function computeVirtualRange(items, scrollTop, viewportHeight, avgHeight, overscan, windowSize, heights) {
  const prefix = buildPrefixHeights(items, heights, avgHeight)
  const start = Math.max(0, findStartIndex(prefix, scrollTop) - overscan)
  let end = Math.min(items.length, start + windowSize + overscan * 2)
  // 固定窗口：严格限制 end-start 不超过 windowSize + overscan*2
  return { start, end, prefix }
}

export function getSpacerHeights(prefix, start, end) {
  const top = prefix[start]
  const total = prefix[prefix.length - 1]
  const bottom = Math.max(0, total - prefix[end])
  return { top, bottom, total }
}
```

### Task 3: Add tests (TDD)

**Files:**
- Create: `tests/virtual-scroll.test.js`

- [ ] **Step 1: Write failing tests**

```js
import { describe, it, expect } from 'vitest'
import { buildPrefixHeights, computeVirtualRange, getSpacerHeights } from '../src/lib/virtual-scroll.js'

describe('virtual scroll helpers', () => {
  it('builds prefix heights with avg fallback', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const heights = new Map([['b', 80]])
    const prefix = buildPrefixHeights(items, heights, 50)
    expect(prefix).toEqual([0, 50, 130, 180])
  })

  it('computes range with window cap', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: String(i) }))
    const heights = new Map()
    const { start, end } = computeVirtualRange(items, 0, 600, 30, 20, 40, heights)
    expect(end - start).toBeLessThanOrEqual(80)
  })

  it('spacer heights sum to total', () => {
    const prefix = [0, 50, 100, 150]
    const { top, bottom, total } = getSpacerHeights(prefix, 1, 2)
    expect(top + bottom + (prefix[2] - prefix[1])).toBe(total)
  })
})
```

- [ ] **Step 2: Run tests (expect FAIL)**

```powershell
npm run test
```
Expected: FAIL if helpers not implemented.

- [ ] **Step 3: Implement helpers (Step 2) then re-run tests (expect PASS)**

```powershell
npm run test
```

- [ ] **Step 4: Commit helpers + tests**

```powershell
git add src\lib\virtual-scroll.js tests\virtual-scroll.test.js package.json package-lock.json
git commit -m "test: add virtual scroll helpers"
```

---

## Chunk 2: Integrate virtual scroll into chat

### Task 4: Add state + range calc

**Files:**
- Modify: `src/pages/chat.js:64-2000`

- [ ] **Step 1: Add constants + state**

```js
const VIRTUAL_WINDOW = 40
const VIRTUAL_OVERSCAN = 20
let _virtualEnabled = true
let _virtualHeights = new Map()
let _virtualAvgHeight = 64
let _virtualRange = { start: 0, end: 0, prefix: [0] }
```

- [ ] **Step 2: Import helpers**

```js
import { computeVirtualRange, getSpacerHeights } from '../lib/virtual-scroll.js'
```

- [ ] **Step 3: Scroll handler**

On scroll, compute range using `computeVirtualRange(items, scrollTop, viewportHeight, _virtualAvgHeight, VIRTUAL_OVERSCAN, VIRTUAL_WINDOW, _virtualHeights)` and update `_virtualRange` when changed.

### Task 5: Render with spacers + measurement

**Files:**
- Modify: `src/pages/chat.js:1380-1750`

- [ ] **Step 1: Render spacers + window**

Insert:
- top spacer with height = `getSpacerHeights(prefix, start, end).top`
- visible items = `items.slice(start, end)`
- bottom spacer with height = `getSpacerHeights(prefix, start, end).bottom`

- [ ] **Step 2: Measure heights**

After render (requestAnimationFrame), measure visible `.msg` nodes using `getBoundingClientRect().height`, update `_virtualHeights`, and recompute `_virtualAvgHeight`.

- [ ] **Step 3: Anchor strategy**

If user is at bottom (within 80px), auto scroll to bottom after new message. Otherwise, preserve scroll position by capturing `scrollTop` before re-render and adjusting by delta in top spacer height.

### Task 6: Build

```powershell
npm run build
```
Expected: Build succeeds without errors.

### Task 7: Commit + Push

```powershell
git add src\pages\chat.js
git commit -m "feat: chat virtual scroll"
git push
```
