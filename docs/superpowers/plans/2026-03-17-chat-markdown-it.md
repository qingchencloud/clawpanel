# Chat Markdown-it Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat Markdown renderer with markdown-it plus plugins to support underline, spoiler, and mention, matching GitHub-like behavior.

**Architecture:** Use markdown-it with html disabled, link validation, custom renderer for code blocks using existing highlightCode. Add local plugins for spoiler (|| || + >! !<) and mention (@user), and use markdown-it-ins for underline rendering to <u>.

**Tech Stack:** JS, Vite

---

## Chunk 1: Dependencies + renderer refactor

### Task 1: Add markdown-it and plugin deps

**Files:**
- Modify: `package.json`

- [ ] **Step 0: Checkpoint（PowerShell）**

```powershell
git status -sb
git commit --allow-empty -m "chore: checkpoint before markdown-it"
```

- [ ] **Step 1: Add dependencies**

Add to dependencies:
- markdown-it
- markdown-it

- [ ] **Step 2: Install**

```powershell
npm install
```

- [ ] **Step 3: Commit deps**

```powershell
git add package.json package-lock.json
git commit -m "chore: add markdown-it deps"
```

### Task 2: Replace renderer

**Files:**
- Modify: `src/lib/markdown.js`

- [ ] **Step 1: Instantiate markdown-it**

```js
import MarkdownIt from 'markdown-it'
import MarkdownIt from 'markdown-it'
```

```js
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight: (code, lang) => {
    const highlighted = highlightCode(code, lang)
    const langLabel = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : ''
    return `<pre data-lang="${escapeHtml(lang)}">${langLabel}<button class="code-copy-btn" onclick="window.__copyCode(this)">Copy</button><code>${highlighted}</code></pre>`
  },
})
```

- [ ] **Step 1.1: Underline plugin (`__text__` -> `<u>`)**

Implement a custom inline rule to parse double-underscore into `<u>` and keep `**` for bold.

- [ ] **Step 2: Link whitelist**

Override link renderer to allow only http/https/mailto, otherwise href="#".

- [ ] **Step 3: Spoiler plugin**

Implement custom plugin to parse:
- `||spoiler||`
- `>!spoiler!<`
Output: `<span class="msg-spoiler">...</span>`

- [ ] **Step 4: Mention plugin**

Parse `@username` into `<span class="msg-mention">@username</span>`.

- [ ] **Step 5: Update renderMarkdown**

Replace manual parsing with `md.render(text)`.

## Chunk 2: Styling

### Task 3: Add styles

**Files:**
- Modify: `src/style/chat.css` or `src/style/components.css`

- [ ] **Step 1: Add mention style**

```css
.msg-mention {
  color: var(--accent);
  font-weight: 600;
}
```

- [ ] **Step 2: Add spoiler style**

```css
.msg-spoiler {
  background: currentColor;
  color: transparent;
  border-radius: 4px;
  padding: 0 4px;
  cursor: pointer;
}
.msg-spoiler.revealed {
  color: inherit;
  background: rgba(0,0,0,0.12);
}
```

- [ ] **Step 3: Add click handler**

In chat init or render, add event delegation to toggle `revealed` class on `.msg-spoiler`.

## Chunk 3: Build + Commit

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: Build succeeds without errors.

- [ ] **Step 2: Commit**

```powershell
git add src\lib\markdown.js src\style\chat.css src\style\components.css
git commit -m "feat: markdown-it rendering"
```

- [ ] **Step 3: Push**

```powershell
git push
```
