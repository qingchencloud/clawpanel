<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  OpenClaw Management Panel with Built-in AI Assistant — One-click Install, Configure, Diagnose & Fix
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> | <strong>🇺🇸 English</strong>
</p>

<p align="center">
  <a href="https://github.com/qingchencloud/clawpanel/releases/latest">
    <img src="https://img.shields.io/github/v/release/qingchencloud/clawpanel?style=flat-square&color=6366f1" alt="Release">
  </a>
  <a href="https://github.com/qingchencloud/clawpanel/releases/latest">
    <img src="https://img.shields.io/github/downloads/qingchencloud/clawpanel/total?style=flat-square&color=8b5cf6" alt="Downloads">
  </a>
  <a href="https://github.com/qingchencloud/clawpanel/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="License">
  </a>
  <a href="https://github.com/qingchencloud/clawpanel/actions/workflows/ci.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/qingchencloud/clawpanel/ci.yml?style=flat-square&label=CI" alt="CI">
  </a>
</p>

---

<p align="center">
  <img src="docs/feature-showcase.gif" width="800" alt="ClawPanel Feature Showcase">
</p>

ClawPanel is a visual management panel for the [OpenClaw](https://openclaw.ai) AI Agent framework. It features a **built-in intelligent AI assistant** that helps you install OpenClaw with one click, auto-diagnose configurations, troubleshoot issues, and fix errors. 8 tools + 4 modes + interactive Q&A — easy to manage for beginners and experts alike.

> 🌐 **Website**: [claw.qt.cool](https://claw.qt.cool/) | 📦 **Download**: [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest)

## Features

### Dashboard & Monitoring
- **Real-time Dashboard** — Gateway status, version info, agent fleet, model pool, service health at a glance
- **Log Viewer** — Real-time Gateway logs with search and filtering
- **System Diagnostics** — Auto-detect configuration issues, WebSocket connectivity, pairing status

### AI Assistant (Built-in)
- **8 Built-in Tools** — Terminal execution, file read/write, directory browsing, web search, URL fetching, system info, process management, port checking
- **4 Modes** — Full auto, semi-auto, read-only, chat-only
- **Tool Calling** — AI can directly execute commands, read logs, modify configs to diagnose and fix problems
- **QingchenCloud Integration** — Free partial model access for panel users, premium models at 2-3x discount for paid users

### Model Configuration
- **Multi-Provider** — OpenAI, Anthropic, DeepSeek, Google Gemini, Ollama, SiliconFlow, Volcengine, Alibaba Cloud, and more
- **One-click Model Add** — Browse and select models from QingchenCloud catalog
- **Model Testing** — Test any model with a single click before deploying
- **Primary/Fallback** — Set primary model with automatic fallback to alternatives

### Agent Management
- **Multi-Agent** — Create and manage multiple AI agents with independent workspaces
- **Identity & Personality** — Configure name, emoji, model for each agent
- **Memory Files** — Manage SOUL.md, IDENTITY.md, AGENTS.md workspace files
- **Workspace Isolation** — Each agent has its own memory, tools, and configuration

### Messaging Channels
- **QQ Bot** — Built-in QQ robot integration via QQ Open Platform
- **Telegram** — Bot Token authentication
- **Discord** — Bot with guild/channel management
- **Feishu/Lark** — Enterprise messaging with WebSocket mode
- **DingTalk** — Enterprise app with Stream mode robot
- **Multi-Account** — Bind different accounts to different agents

### Gateway & Services
- **Gateway Control** — Start, stop, restart OpenClaw Gateway
- **Auto-Guardian** — Automatic Gateway restart on unexpected exit (with cooldown)
- **Config Editor** — Direct JSON editor for openclaw.json with syntax validation
- **Backup & Restore** — One-click configuration backup and restore

### Cron Jobs
- **Scheduled Tasks** — Create cron-based scheduled AI tasks
- **Delivery Channels** — Route task results to messaging channels
- **Per-Agent Assignment** — Assign tasks to specific agents

### Security
- **Access Password** — Protect Web panel with password authentication
- **Network Proxy** — Configure HTTP/SOCKS proxy for all outbound requests
- **Session Management** — Secure session tokens with expiration

## Installation

### Desktop App (Windows / macOS / Linux)

Download the latest installer from [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest):

| Platform | Download |
|----------|----------|
| **Windows** | `.exe` installer (recommended) or `.msi` |
| **macOS Apple Silicon** | `.dmg` (aarch64) |
| **macOS Intel** | `.dmg` (x64) |
| **Linux** | `.AppImage` / `.deb` / `.rpm` |

### Web Version (No Rust/Tauri Required)

For headless servers, Raspberry Pi, ARM boards, or Docker:

```bash
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel
npm install
npm run serve
# Open http://localhost:1420 in your browser
```

### ARM / Embedded Device Support

ClawPanel provides a **pure Web deployment mode** (zero GUI dependency), natively compatible with ARM64 boards:

- **Orange Pi / Raspberry Pi / RK3588** — `npm run serve` to run
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — Auto-detect architecture
- No Rust / Tauri / GUI needed — **only Node.js 18+ required**

## Quick Start

1. Install and open ClawPanel
2. First run auto-detects Node.js environment and OpenClaw CLI
3. If OpenClaw is not installed, click one-click install (R2 CDN accelerated)
4. After installation, the dashboard loads automatically

> **Requirements**: Node.js 18+ (22 LTS recommended)

## Tech Stack

- **Frontend**: Vanilla JS + CSS Custom Properties (zero framework dependency)
- **Desktop**: Tauri v2 (Rust backend)
- **Web Backend**: Node.js (Express-compatible API server)
- **Build**: Vite
- **CI/CD**: GitHub Actions (cross-platform builds)

## Development

```bash
# Prerequisites: Node.js 22+, Rust toolchain, Tauri CLI

# Clone
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel

# Install dependencies
npm install

# Desktop development (Tauri)
npm run tauri dev

# Web-only development
npm run serve
```

## Contributing

Issues and Pull Requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## License

This project is licensed under [AGPL-3.0](LICENSE). For commercial/proprietary use without open-source requirements, contact us for a commercial license.

© 2026 QingchenCloud (武汉晴辰天下网络科技有限公司) | [claw.qt.cool](https://claw.qt.cool)
