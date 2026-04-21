<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  OpenClaw & Hermes Agent Management Panel with Built-in AI Assistant — Multi-Engine AI Framework Management
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> | <strong>🇺🇸 English</strong> | <a href="README.zh-TW.md">🇹🇼 繁體中文</a> | <a href="README.ja.md">🇯🇵 日本語</a> | <a href="README.ko.md">🇰🇷 한국어</a> | <a href="README.vi.md">🇻🇳 Tiếng Việt</a> | <a href="README.es.md">🇪🇸 Español</a> | <a href="README.pt.md">🇧🇷 Português</a> | <a href="README.ru.md">🇷🇺 Русский</a> | <a href="README.fr.md">🇫🇷 Français</a> | <a href="README.de.md">🇩🇪 Deutsch</a>
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

ClawPanel is a visual management panel supporting multiple AI Agent frameworks, currently with [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) and [Hermes Agent](https://github.com/nousresearch/hermes-agent) dual-engine support. It features a **built-in intelligent AI assistant** that helps you install, auto-diagnose configurations, troubleshoot issues, and fix errors. 8 tools + 4 modes + interactive Q&A — easy to manage for beginners and experts alike.

> 🌐 **Website**: [claw.qt.cool](https://claw.qt.cool/) | 📦 **Download**: [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest)

### 🎁 QingchenCloud AI API

> Internal technical testing platform, open for selected users. Sign in daily to earn credits.

<p align="center">
  <a href="https://gpt.qt.cool"><img src="https://img.shields.io/badge/🔑 QingchenCloud AI-gpt.qt.cool-6366f1?style=for-the-badge" alt="QingchenCloud AI"></a>
</p>

- **Daily Sign-in Credits** — Sign in daily + invite friends to earn test credits
- **OpenAI-Compatible API** — Seamless integration with OpenClaw, plug and play
- **Resource Policy** — Rate limiting + request caps, may queue during peak hours
- **Model Availability** — Models/APIs subject to actual page display, may rotate versions

> ⚠️ **Compliance**: This platform is for technical testing only. Illegal use or circumventing security mechanisms is prohibited. Keep your API Key secure. Rules subject to latest platform policies.

### 🔥 Dev Board / Embedded Device Support

ClawPanel provides a **pure Web deployment mode** (zero GUI dependency), natively compatible with ARM64 boards:

- **Orange Pi / Raspberry Pi / RK3588** — `npm run serve` to run
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — Auto-detect architecture
- No Rust / Tauri / GUI needed — **only Node.js 18+ required**

> 📖 See [Armbian Deployment Guide](docs/armbian-deploy.md) | [Web Dev Mode](#web-version-no-rusttauri-required)

## Community

A community of passionate AI Agent developers and enthusiasts — join us!

<p align="center">
  <a href="https://discord.gg/U9AttmsNHh"><strong>Discord</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/discussions"><strong>Discussions</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/issues/new"><strong>Report Issue</strong></a>
</p>

## Features

- **🤖 AI Assistant (New)** — Built-in AI assistant, 4 modes + 8 tools + interactive Q&A. See [AI Assistant Highlights](#-ai-assistant-highlights)
- **🧩 Multi-Engine Architecture** — Supports both OpenClaw and Hermes Agent dual engines, freely switchable, independently managed
- **🤖 Hermes Agent Chat** — Built-in Hermes Agent chat interface with tool call visualization, file system access toggle, SSE streaming output
- **🖼️ Image Recognition** — Paste screenshots or drag images, AI auto-analyzes, multimodal conversations
- **Dashboard** — System overview, real-time service monitoring, quick actions
- **Service Management** — OpenClaw / Hermes Gateway start/stop, version detection & one-click upgrade, config backup & restore
- **Model Configuration** — Multi-provider management, model CRUD, batch connectivity tests, latency detection, drag-to-reorder, auto-save + undo
- **Gateway Configuration** — Port, access scope (localhost/LAN), auth Token, Tailscale networking
- **Messaging Channels** — Unified Telegram, Discord, Feishu, DingTalk, QQ management, multi-Agent binding per platform
- **Communication & Automation** — Message settings, broadcast strategies, slash commands, Webhooks, execution approval
- **Usage Analytics** — Token usage, API costs, model/provider/tool rankings, daily usage charts
- **Agent Management** — Agent CRUD, identity editing, model config, workspace management
- **Chat** — Streaming, Markdown rendering, session management, /fast /think /verbose /reasoning commands
- **Cron Jobs** — Cron-based scheduled execution, multi-channel delivery
- **Log Viewer** — Multi-source real-time logs with keyword search
- **Memory Management** — Memory file view/edit, categorized management, ZIP export, Agent switching
- **QingchenCloud AI API** — Internal testing platform, OpenAI-compatible, daily sign-in credits
- **Extensions** — cftunnel tunnel management, ClawApp status monitoring
- **About** — Version info, community links, related projects, one-click upgrade

## Download & Install

Go to [Releases](https://github.com/qingchencloud/clawpanel/releases/latest) for the latest version:

### macOS

| Chip | Installer | Notes |
|------|-----------|-------|
| Apple Silicon (M1/M2/M3/M4) | `ClawPanel_x.x.x_aarch64.dmg` | Macs from late 2020+ |
| Intel | `ClawPanel_x.x.x_x64.dmg` | Macs 2020 and earlier |

> **⚠️ "Damaged" or "unverified developer"?** App is unsigned. Run: `sudo xattr -rd com.apple.quarantine /Applications/ClawPanel.app`

### Windows

| Format | Installer | Notes |
|--------|-----------|-------|
| EXE | `ClawPanel_x.x.x_x64-setup.exe` | Recommended |
| MSI | `ClawPanel_x.x.x_x64_en-US.msi` | Enterprise / silent install |

### Linux

| Format | Installer | Notes |
|--------|-----------|-------|
| AppImage | `ClawPanel_x.x.x_amd64.AppImage` | No install, `chmod +x` and run |
| DEB | `ClawPanel_x.x.x_amd64.deb` | `sudo dpkg -i *.deb` |
| RPM | `ClawPanel-x.x.x-1.x86_64.rpm` | `sudo rpm -i *.rpm` |

### Linux Server (Web Version)

```bash
curl -fsSL https://raw.githubusercontent.com/qingchencloud/clawpanel/main/scripts/linux-deploy.sh | bash
```

Visit `http://YOUR_SERVER_IP:1420` after deployment. 📖 [Linux Deployment Guide](docs/linux-deploy.md)

### Docker

```bash
docker run -d --name clawpanel --restart unless-stopped \
  -p 1420:1420 -v clawpanel-data:/root/.openclaw \
  node:22-slim \
  sh -c "apt-get update && apt-get install -y git && \
    npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com && \
    git clone https://github.com/qingchencloud/clawpanel.git /app && \
    cd /app && npm install && npm run build && npm run serve"
```

📖 [Docker Deployment Guide](docs/docker-deploy.md)

## Quick Start

1. **Initial Setup** — First launch auto-detects Node.js, Git, OpenClaw. One-click install if missing.
2. **Configure Models** — Add AI providers (DeepSeek, MiniMax, OpenAI, Ollama, etc.) with API keys. Test connectivity.
3. **Start Gateway** — Go to Service Management, click Start. Green status = ready.
4. **Start Chatting** — Go to Live Chat, select model, start conversation with streaming & Markdown.

## 🤖 AI Assistant Highlights

Built-in AI assistant that can **directly operate your system** — diagnose, fix, even submit PRs.

### Four Modes

| Mode | Icon | Tools | Write | Confirm | Use Case |
|------|------|-------|-------|---------|----------|
| **Chat** | 💬 | ❌ | ❌ | — | Pure Q&A |
| **Plan** | 📋 | ✅ | ❌ | ✅ | Read configs/logs, output plans |
| **Execute** | ⚡ | ✅ | ✅ | ✅ | Normal work, dangerous ops need confirm |
| **Unlimited** | ∞ | ✅ | ✅ | ❌ | Full auto, no prompts |

### Eight Tools

| Tool | Function |
|------|----------|
| `ask_user` | Ask user questions (single/multi/text) |
| `get_system_info` | Get OS, architecture, home directory |
| `run_command` | Execute shell commands |
| `read_file` / `write_file` | Read/write files |
| `list_directory` | Browse directories |
| `list_processes` | View processes |
| `check_port` | Check port usage |

## Tech Architecture

| Layer | Technology | Description |
|-------|-----------|-------------|
| Frontend | Vanilla JS + Vite | Zero framework, lightweight |
| Backend | Rust + Tauri v2 | Native performance, cross-platform |
| Communication | Tauri IPC + Shell Plugin | Frontend-backend bridge |
| Styling | Pure CSS (CSS Variables) | Dark/Light themes, glassmorphism |

## Build from Source

```bash
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel && npm install

# Desktop (requires Rust + Tauri v2)
npm run tauri dev        # Development
npm run tauri build      # Production

# Web only (no Rust needed)
npm run dev              # Dev with hot reload
npm run build && npm run serve  # Production
```

## FAQ

### Hot Update Caused UI Issues / Rolling Back to Built-in Version

ClawPanel desktop supports frontend hot updates. Update files are stored at:

| OS | Path |
|----|------|
| Windows | `%USERPROFILE%\.openclaw\clawpanel\web-update\` |
| macOS / Linux | `~/.openclaw/clawpanel/web-update/` |

If the UI looks broken after a hot update or you want to revert to the version bundled with the installer, simply delete that directory and restart:

```bash
# macOS / Linux
rm -rf ~/.openclaw/clawpanel/web-update

# Windows PowerShell
Remove-Item -Recurse -Force "$env:USERPROFILE\.openclaw\clawpanel\web-update"
```

After restarting ClawPanel, the built-in frontend resources will be used automatically.

## Related Projects

| Project | Description |
|---------|-------------|
| [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) | AI Agent Framework |
| [ClawApp](https://github.com/qingchencloud/clawapp) | Cross-platform mobile chat client |
| [cftunnel](https://github.com/qingchencloud/cftunnel) | Cloudflare Tunnel tool |

## Contributing

Issues and Pull Requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Acknowledgements

ClawPanel keeps growing because of every contributor in the community. Thank you for helping make the project better.

### Code Contributors

Thanks to these developers for submitting Pull Requests and contributing directly to the codebase:

<table>
  <tr>
    <td align="center"><a href="https://github.com/liucong2013"><img src="https://github.com/liucong2013.png?size=80" width="60" height="60"><br><sub><b>liucong2013</b></sub></a><br><a href="https://github.com/qingchencloud/clawpanel/pull/88">#88</a></td>
    <td align="center"><a href="https://github.com/axdlee"><img src="https://github.com/axdlee.png?size=80" width="60" height="60"><br><sub><b>axdlee</b></sub></a><br><a href="https://github.com/qingchencloud/clawpanel/pull/58">#58</a></td>
    <td align="center"><a href="https://github.com/ATGCS"><img src="https://github.com/ATGCS.png?size=80" width="60" height="60"><br><sub><b>ATGCS</b></sub></a><br><a href="https://github.com/qingchencloud/clawpanel/pull/107">#107</a></td>
    <td align="center"><a href="https://github.com/livisun"><img src="https://github.com/livisun.png?size=80" width="60" height="60"><br><sub><b>livisun</b></sub></a><br><a href="https://github.com/qingchencloud/clawpanel/pull/106">#106</a></td>
    <td align="center"><a href="https://github.com/kiss-kedaya"><img src="https://github.com/kiss-kedaya.png?size=80" width="60" height="60"><br><sub><b>kiss-kedaya</b></sub></a><br><a href="https://github.com/qingchencloud/clawpanel/pull/101">#101</a> <a href="https://github.com/qingchencloud/clawpanel/pull/94">#94</a></td>
    <td align="center"><a href="https://github.com/wzh4869"><img src="https://github.com/wzh4869.png?size=80" width="60" height="60"><br><sub><b>wzh4869</b></sub></a><br><a href="https://github.com/qingchencloud/clawpanel/pull/82">#82</a></td>
    <td align="center"><a href="https://github.com/0xsline"><img src="https://github.com/0xsline.png?size=80" width="60" height="60"><br><sub><b>0xsline</b></sub></a><br><a href="https://github.com/qingchencloud/clawpanel/pull/15">#15</a></td>
    <td align="center"><a href="https://github.com/jonntd"><img src="https://github.com/jonntd.png?size=80" width="60" height="60"><br><sub><b>jonntd</b></sub></a><br><a href="https://github.com/qingchencloud/clawpanel/pull/18">#18</a></td>
  </tr>
</table>

### Community Reporters

Thanks to community members who opened issues, reported bugs, and suggested features:

<a href="https://github.com/asfork"><img src="https://github.com/asfork.png?size=40" width="32" height="32" title="asfork"></a>
<a href="https://github.com/p1ayer222"><img src="https://github.com/p1ayer222.png?size=40" width="32" height="32" title="p1ayer222"></a>
<a href="https://github.com/ntescn"><img src="https://github.com/ntescn.png?size=40" width="32" height="32" title="ntescn"></a>
<a href="https://github.com/song860"><img src="https://github.com/song860.png?size=40" width="32" height="32" title="song860"></a>
<a href="https://github.com/gtgc2005"><img src="https://github.com/gtgc2005.png?size=40" width="32" height="32" title="gtgc2005"></a>
<a href="https://github.com/Eternity714"><img src="https://github.com/Eternity714.png?size=40" width="32" height="32" title="Eternity714"></a>
<a href="https://github.com/flyingnight"><img src="https://github.com/flyingnight.png?size=40" width="32" height="32" title="flyingnight"></a>
<a href="https://github.com/genan1989"><img src="https://github.com/genan1989.png?size=40" width="32" height="32" title="genan1989"></a>
<a href="https://github.com/alexluoli"><img src="https://github.com/alexluoli.png?size=40" width="32" height="32" title="alexluoli"></a>
<a href="https://github.com/iethancode"><img src="https://github.com/iethancode.png?size=40" width="32" height="32" title="iethancode"></a>
<a href="https://github.com/glive1991-bit"><img src="https://github.com/glive1991-bit.png?size=40" width="32" height="32" title="glive1991-bit"></a>
<a href="https://github.com/hYRamos"><img src="https://github.com/hYRamos.png?size=40" width="32" height="32" title="hYRamos"></a>
<a href="https://github.com/htone8"><img src="https://github.com/htone8.png?size=40" width="32" height="32" title="htone8"></a>
<a href="https://github.com/evanervx"><img src="https://github.com/evanervx.png?size=40" width="32" height="32" title="evanervx"></a>
<a href="https://github.com/qjman524"><img src="https://github.com/qjman524.png?size=40" width="32" height="32" title="qjman524"></a>
<a href="https://github.com/yahwist00"><img src="https://github.com/yahwist00.png?size=40" width="32" height="32" title="yahwist00"></a>
<a href="https://github.com/catfishlty"><img src="https://github.com/catfishlty.png?size=40" width="32" height="32" title="catfishlty"></a>
<a href="https://github.com/ufoleon"><img src="https://github.com/ufoleon.png?size=40" width="32" height="32" title="ufoleon"></a>
<a href="https://github.com/fengzhao"><img src="https://github.com/fengzhao.png?size=40" width="32" height="32" title="fengzhao"></a>
<a href="https://github.com/nicoxia"><img src="https://github.com/nicoxia.png?size=40" width="32" height="32" title="nicoxia"></a>
<a href="https://github.com/friendfish"><img src="https://github.com/friendfish.png?size=40" width="32" height="32" title="friendfish"></a>
<a href="https://github.com/pdsy520"><img src="https://github.com/pdsy520.png?size=40" width="32" height="32" title="pdsy520"></a>
<a href="https://github.com/CaoJingBiao"><img src="https://github.com/CaoJingBiao.png?size=40" width="32" height="32" title="CaoJingBiao"></a>
<a href="https://github.com/LwdAmazing"><img src="https://github.com/LwdAmazing.png?size=40" width="32" height="32" title="LwdAmazing"></a>
<a href="https://github.com/joeshen2021"><img src="https://github.com/joeshen2021.png?size=40" width="32" height="32" title="joeshen2021"></a>
<a href="https://github.com/Qentin39"><img src="https://github.com/Qentin39.png?size=40" width="32" height="32" title="Qentin39"></a>
<a href="https://github.com/wzgrx"><img src="https://github.com/wzgrx.png?size=40" width="32" height="32" title="wzgrx"></a>
<a href="https://github.com/aixinjie"><img src="https://github.com/aixinjie.png?size=40" width="32" height="32" title="aixinjie"></a>
<a href="https://github.com/wangziqi7"><img src="https://github.com/wangziqi7.png?size=40" width="32" height="32" title="wangziqi7"></a>
<a href="https://github.com/kizuzz"><img src="https://github.com/kizuzz.png?size=40" width="32" height="32" title="kizuzz"></a>
<a href="https://github.com/lizheng31"><img src="https://github.com/lizheng31.png?size=40" width="32" height="32" title="lizheng31"></a>
<a href="https://github.com/Yafeiml"><img src="https://github.com/Yafeiml.png?size=40" width="32" height="32" title="Yafeiml"></a>
<a href="https://github.com/ethanbase"><img src="https://github.com/ethanbase.png?size=40" width="32" height="32" title="ethanbase"></a>
<a href="https://github.com/BBcactus"><img src="https://github.com/BBcactus.png?size=40" width="32" height="32" title="BBcactus"></a>
<a href="https://github.com/AGLcaicai"><img src="https://github.com/AGLcaicai.png?size=40" width="32" height="32" title="AGLcaicai"></a>
<a href="https://github.com/zhugeafu"><img src="https://github.com/zhugeafu.png?size=40" width="32" height="32" title="zhugeafu"></a>
<a href="https://github.com/sc-yx"><img src="https://github.com/sc-yx.png?size=40" width="32" height="32" title="sc-yx"></a>
<a href="https://github.com/themeke"><img src="https://github.com/themeke.png?size=40" width="32" height="32" title="themeke"></a>
<a href="https://github.com/erlangzhang"><img src="https://github.com/erlangzhang.png?size=40" width="32" height="32" title="erlangzhang"></a>
<a href="https://github.com/YamanZzz"><img src="https://github.com/YamanZzz.png?size=40" width="32" height="32" title="YamanZzz"></a>
<a href="https://github.com/huanghun5172"><img src="https://github.com/huanghun5172.png?size=40" width="32" height="32" title="huanghun5172"></a>
<a href="https://github.com/kongjian19930520"><img src="https://github.com/kongjian19930520.png?size=40" width="32" height="32" title="kongjian19930520"></a>
<a href="https://github.com/XIAzhenglin"><img src="https://github.com/XIAzhenglin.png?size=40" width="32" height="32" title="XIAzhenglin"></a>
<a href="https://github.com/dacj4n"><img src="https://github.com/dacj4n.png?size=40" width="32" height="32" title="dacj4n"></a>
<a href="https://github.com/lzzandsx"><img src="https://github.com/lzzandsx.png?size=40" width="32" height="32" title="lzzandsx"></a>
<a href="https://github.com/qiangua5210"><img src="https://github.com/qiangua5210.png?size=40" width="32" height="32" title="qiangua5210"></a>
<a href="https://github.com/yzswk"><img src="https://github.com/yzswk.png?size=40" width="32" height="32" title="yzswk"></a>
<a href="https://github.com/nasvip"><img src="https://github.com/nasvip.png?size=40" width="32" height="32" title="nasvip"></a>
<a href="https://github.com/yyy22335"><img src="https://github.com/yyy22335.png?size=40" width="32" height="32" title="yyy22335"></a>
<a href="https://github.com/yuanjie408"><img src="https://github.com/yuanjie408.png?size=40" width="32" height="32" title="yuanjie408"></a>
<a href="https://github.com/qingahan"><img src="https://github.com/qingahan.png?size=40" width="32" height="32" title="qingahan"></a>
<a href="https://github.com/mentho7"><img src="https://github.com/mentho7.png?size=40" width="32" height="32" title="mentho7"></a>
<a href="https://github.com/AspirantH"><img src="https://github.com/AspirantH.png?size=40" width="32" height="32" title="AspirantH"></a>
<a href="https://github.com/skkjkk"><img src="https://github.com/skkjkk.png?size=40" width="32" height="32" title="skkjkk"></a>
<a href="https://github.com/penghaiqiu1988"><img src="https://github.com/penghaiqiu1988.png?size=40" width="32" height="32" title="penghaiqiu1988"></a>
<a href="https://github.com/cfx2020"><img src="https://github.com/cfx2020.png?size=40" width="32" height="32" title="cfx2020"></a>
<a href="https://github.com/birdxs"><img src="https://github.com/birdxs.png?size=40" width="32" height="32" title="birdxs"></a>
<a href="https://github.com/szuforti"><img src="https://github.com/szuforti.png?size=40" width="32" height="32" title="szuforti"></a>
<a href="https://github.com/baiyucraft"><img src="https://github.com/baiyucraft.png?size=40" width="32" height="32" title="baiyucraft"></a>
<a href="https://github.com/arnzh"><img src="https://github.com/arnzh.png?size=40" width="32" height="32" title="arnzh"></a>
<a href="https://github.com/xyiqq"><img src="https://github.com/xyiqq.png?size=40" width="32" height="32" title="xyiqq"></a>
<a href="https://github.com/tonyzhangbo78"><img src="https://github.com/tonyzhangbo78.png?size=40" width="32" height="32" title="tonyzhangbo78"></a>
<a href="https://github.com/try-to"><img src="https://github.com/try-to.png?size=40" width="32" height="32" title="try-to"></a>
<a href="https://github.com/irunmyway"><img src="https://github.com/irunmyway.png?size=40" width="32" height="32" title="irunmyway"></a>
<a href="https://github.com/Oliveelick"><img src="https://github.com/Oliveelick.png?size=40" width="32" height="32" title="Oliveelick"></a>
<a href="https://github.com/56025192"><img src="https://github.com/56025192.png?size=40" width="32" height="32" title="56025192"></a>
<a href="https://github.com/aliceQWAS"><img src="https://github.com/aliceQWAS.png?size=40" width="32" height="32" title="aliceQWAS"></a>
<a href="https://github.com/qingdeng888"><img src="https://github.com/qingdeng888.png?size=40" width="32" height="32" title="qingdeng888"></a>
<a href="https://github.com/18574707971"><img src="https://github.com/18574707971.png?size=40" width="32" height="32" title="18574707971"></a>

> If we missed your contribution, please [open an issue](https://github.com/qingchencloud/clawpanel/issues/new) and we will add it promptly.

## Sponsor

If you find this project useful, consider supporting us via USDT (BNB Smart Chain):

<img src="public/images/bnbqr.jpg" alt="Sponsor QR" width="180">

```
0xbdd7ebdf2b30d873e556799711021c6671ffe88f
```

## Contact

- **Email**: [support@qctx.net](mailto:support@qctx.net)
- **Website**: [qingchencloud.com](https://qingchencloud.com)
- **Product**: [claw.qt.cool](https://claw.qt.cool)

## License

This project is licensed under [AGPL-3.0](LICENSE). For commercial/proprietary use without open-source requirements, contact us for a commercial license.

© 2026 QingchenCloud (武汉晴辰天下网络科技有限公司) | [claw.qt.cool](https://claw.qt.cool)
