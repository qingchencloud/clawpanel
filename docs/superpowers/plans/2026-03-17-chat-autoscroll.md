# Chat Auto-Scroll Gating Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only auto-scroll the chat view when new messages arrive and the user is at the bottom; never force-scroll while the user is reading history.

**Architecture:** Add a single auto-scroll gate to `chat.js` that tracks whether the user is at the bottom. Trigger scrolling only on message insertion and stream updates when the gate is enabled. Avoid auto-scroll in render loops to prevent continuous snapping.

**Tech Stack:** Vanilla JS, DOM APIs, existing chat page logic in `src/pages/chat.js`.

---

## Chunk 1: Auto-scroll gating

### Task 1: Add auto-scroll state and update on scroll

**Files:**
- Modify: `src/pages/chat.js`

- [ ] **Step 1: Add state flags near other module-level state**

Add:
```js
let _autoScrollEnabled = true
```

- [ ] **Step 2: Update auto-scroll flag on scroll**

In the `_messagesEl.addEventListener('scroll', ...)` handler, update state based on `isAtBottom()`:
```js
_messagesEl.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = _messagesEl
  _scrollBtn.style.display = (scrollHeight - scrollTop - clientHeight < 80) ? 'none' : 'flex'
  _autoScrollEnabled = isAtBottom()
})
```

- [ ] **Step 3: Ensure scroll button restores auto-scroll**

When the user clicks the scroll-to-bottom button, set `_autoScrollEnabled = true` after moving to bottom:
```js
_scrollBtn.addEventListener('click', () => {
  _autoScrollEnabled = true
  scrollToBottom(true)
})
```

### Task 2: Gate auto-scroll to message insertion

**Files:**
- Modify: `src/pages/chat.js`

- [ ] **Step 1: Update `scrollToBottom` to respect gating**

Change function signature and behavior:
```js
function scrollToBottom(force = false) {
  if (!_messagesEl) return
  if (!force && !_autoScrollEnabled) return
  requestAnimationFrame(() => { _messagesEl.scrollTop = _messagesEl.scrollHeight })
}
```

- [ ] **Step 2: Ensure scroll is invoked only on new message insertion**

Keep `scrollToBottom()` calls only in:
- `appendUserMessage`
- `appendAiMessage`
- `appendSystemMessage`
- `createStreamBubble`
- `showTyping(true)` (but it will now respect gate)

Remove or avoid unconditional scrolling in render loops.

- [ ] **Step 3: Stop continuous auto-scroll in render loops**

In `doRender` remove the unconditional `scrollToBottom()` or guard it by auto-scroll:
```js
if (_currentAiBubble && _currentAiText) {
  _currentAiBubble.innerHTML = renderMarkdown(_currentAiText)
  scrollToBottom()
}
```
(With gated `scrollToBottom`, it will only happen when user is at bottom.)

- [ ] **Step 4: Guard virtual render bottom snapping**

In `doVirtualRender`, only snap to bottom when `_autoScrollEnabled` is true:
```js
if (atBottom && _autoScrollEnabled) {
  scrollToBottom()
}
```

### Task 3: Validate streaming behavior

**Files:**
- Modify: `src/pages/chat.js`

- [ ] **Step 1: Ensure stream updates do not force-scroll while reading history**

Verify `doRender` and `createStreamBubble` only scroll when `_autoScrollEnabled` is true.

### Task 4: Manual verification and build

**Files:**
- None

- [ ] **Step 1: Manual verification checklist**

Checklist:
- Open chat page with existing history
- Scroll up; verify the view stays in place (no automatic snapping)
- Send a new message while scrolled up; verify it does not force-scroll
- Scroll to bottom and send/receive a message; verify it auto-scrolls
- Click the scroll-to-bottom button; verify it jumps and re-enables auto-scroll

- [ ] **Step 2: Build**

Run:
```powershell
npm run build
```
Expected: build succeeds with no errors.

- [ ] **Step 3: Commit**

```powershell
git add src\pages\chat.js

git commit -m "fix: gate chat auto-scroll on new messages"
```
