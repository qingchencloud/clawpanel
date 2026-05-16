# AGENTS.md

## Cursor Cloud specific instructions

### Overview

ClawPanel is a cross-platform AI Agent management panel (Vanilla JS + Vite frontend, optional Rust/Tauri desktop backend). In Cloud Agent environments, only the **Web development mode** is relevant—no Rust/Tauri compilation is needed.

### Running the development server

```bash
npm run dev
```

This starts Vite on port 1420 with a `dev-api.js` plugin that provides mock/real backend API endpoints. Open http://localhost:1420 in Chrome. The default password is pre-filled on the login screen (the panel stores passwords in `~/.openclaw/clawpanel.json`).

### Running tests

```bash
node --test tests/*.test.js
```

Note: Test 30 (`buildSnapshot.isLatest works against KERNEL_TARGET`) has a pre-existing failure unrelated to environment setup.

### Building

```bash
npm run build
```

Build output goes to `dist/`.

### Key gotchas

- The app uses `package-lock.json`; always use **npm** (not pnpm/yarn).
- No ESLint or Prettier configured for JS; the CI only checks Rust formatting (`cargo fmt --check`) and Rust lint (`cargo clippy`).
- OpenClaw Gateway (port 18789) is an optional external dependency. The panel UI loads fine without it but AI chat features will not function.
- Rust/Tauri system deps (libwebkit2gtk, etc.) are only needed for `npm run tauri dev`/`npm run tauri build`. They are NOT needed for web-only development.
- The Vite config reads `~/.openclaw/openclaw.json` at startup for the Gateway WebSocket proxy port. If the file doesn't exist, it defaults to port 18789.
