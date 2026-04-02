# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClawPanel is a management panel for [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) AI Agent framework. It has two deployment modes:
- **Desktop**: Tauri v2 (Rust + WebView) — full native app
- **Web**: Vite-only — runs in browser, talks to OpenClaw CLI via Node.js subprocess

## Development Commands

```bash
# Install dependencies
npm install

# macOS/Linux: Full Tauri desktop dev (Vite + Rust)
./scripts/dev.sh

# macOS/Linux: Vite only (browser debugging with mock data)
./scripts/dev.sh web

# macOS/Linux: Build debug version
./scripts/build.sh

# macOS/Linux: Rust compile check only (fast)
./scripts/build.sh check

# macOS/Linux: Production build with packaging
./scripts/build.sh release

# Windows: Full Tauri dev
npm run tauri dev

# Windows: Vite only
npm run dev

# Windows: Production build
npm run tauri build

# Build frontend only (works on any platform with Node.js)
npm run build

# Serve built web app (for Linux/ARM/servers)
npm run serve
```

## Architecture

### Frontend (src/)

- **Pages** (`src/pages/*.js`) — 20 page modules, each lazy-loaded via hash router
- **Components** (`src/components/`) — sidebar, modal, toast, ai-drawer, engagement
- **Lib** (`src/lib/`) — tauri-api.js (Tauri invoke wrapper), ws-client.js (WebSocket), app-state.js, theme.js, i18n.js, markdown.js, icons.js, etc.
- **Router** (`src/router.js`) — lightweight hash-based router, async page loading with spinner and retry
- **Locales** (`src/locales/`) — i18n with module-based structure (modules/*.js per page)
- **Style** (`src/style/`) — pure CSS with CSS Variables, glassmorphism dark/light themes

Key frontend patterns:
- Pages export `render()` async function (or `default`) and optional `cleanup()`
- All Tauri IPC calls go through `src/lib/tauri-api.js` → `window.__TAURI_INTERNALS__`
- Web mode uses `scripts/dev-api.js` as mock backend instead of Tauri commands
- Theme toggle: `src/lib/theme.js` sets `data-theme` on `<html>`

### Backend (src-tauri/src/)

- **main.rs** — entry point, calls `clawpanel_lib::run()`
- **lib.rs** — `run()` builder with plugin setup, URI scheme protocol (hot updates), window events, registers all ~90 Tauri commands
- **commands/** — 12 modules: agent, assistant, config, device, extensions, logs, memory, messaging, pairing, service, skills, update
- **models/** — Rust types for structured data
- **tray.rs** — system tray setup (close to tray on macOS/Windows)
- **utils.rs** — shared utilities: `openclaw_dir()`, `gateway_listen_port()`, `enhanced_path()`, HTTP client builders with proxy support

Key Rust utilities:
- `openclaw_dir()` — resolves OpenClaw config directory (~/.openclaw or custom via clawpanel.json)
- `gateway_listen_port()` — reads gateway.port from openclaw.json, cached 5s
- `enhanced_path()` — builds PATH with Node.js version managers (nvm, volta, fnm, nodenv)
- `build_http_client()` / `build_http_client_no_proxy()` — reqwest clients respecting proxy settings

### Data Storage

- OpenClaw config: `~/.openclaw/openclaw.json`
- ClawPanel config: `~/.openclaw/clawpanel.json`
- ClawPanel's `openclawDir` setting in clawpanel.json overrides ~/.openclaw location

## Web Mode vs Desktop Mode

Detect mode: `window.__TAURI_INTERNALS__` is truthy in Tauri, falsy in web.

In web mode:
- `npm run dev` serves Vite dev server + dev-api.js mock backend
- `npm run serve` serves production build with Node.js API server
- Mock backend (`dev-api.js`) simulates OpenClaw CLI responses

## CI/CD

- `.github/workflows/ci.yml` — runs on push/PR: lint, type check, Rust check
- `.github/workflows/release.yml` — builds release for all platforms (macOS aarch64/x64, Windows x64, Linux AppImage/DEB/RPM)

## Version Sync

Frontend and Rust version are kept in sync via `scripts/sync-version.js`. Both `package.json` and `src-tauri/Cargo.toml` must be updated together.
