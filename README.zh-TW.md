<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  內建 AI 助手的多引擎 Agent 管理面板 — OpenClaw、Hermes、DSH、OpenCode 與 Pi
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> | <a href="README.en.md">🇺🇸 English</a> | <strong>🇹🇼 繁體中文</strong> | <a href="README.ja.md">🇯🇵 日本語</a> | <a href="README.ko.md">🇰🇷 한국어</a> | <a href="README.vi.md">🇻🇳 Tiếng Việt</a> | <a href="README.es.md">🇪🇸 Español</a> | <a href="README.pt.md">🇧🇷 Português</a> | <a href="README.ru.md">🇷🇺 Русский</a> | <a href="README.fr.md">🇫🇷 Français</a> | <a href="README.de.md">🇩🇪 Deutsch</a>
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
</p>

---

<p align="center">
  <img src="docs/feature-showcase.gif" width="800" alt="ClawPanel 功能展示">
</p>

ClawPanel 是支援多 AI Agent 框架的視覺化管理面板，目前支援 [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation)、[Hermes Agent](https://github.com/nousresearch/hermes-agent)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[OpenCode](https://github.com/anomalyco/opencode) 和實驗版 [Pi](https://github.com/earendil-works/pi)。**內建智慧 AI 助手**，協助安裝、診斷設定與排除問題。

> 🌐 **官網**: [claw.qt.cool](https://claw.qt.cool/) | 📦 **下載**: [官網下載中心](https://claw.qt.cool/download) | 備用: [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest) | 國內鏡像: [AtomGit](https://atomgit.com/qingchencloud/clawpanel)

### 🧪 免費測試：晴辰雲

[晴辰雲](https://gpt.qt.cool/)是 ClawPanel 配套的免費簽到測試平台，適合模型體驗與功能驗證。ClawPanel 不內建或自動讀取晴辰雲金鑰；請自行註冊並前往[簽到頁](https://gpt.qt.cool/checkin)取得測試額度與 API Key，再手動貼到 ClawPanel 選擇模型並一鍵設定。具體開放狀態和額度規則以晴辰雲頁面為準。

### 🤝 贊助推廣：詞元 API

> 第三方贊助推廣，具體規則以詞元 API 頁面為準。

<p align="center">
  <a href="https://ciyapi.79tian.com" rel="sponsored noopener noreferrer"><img src="https://img.shields.io/badge/🤝 詞元 API-贊助推廣-6366f1?style=for-the-badge" alt="詞元 API 贊助推廣"></a>
</p>

- **主流前沿模型** — 支援 GPT、Claude、Gemini、Grok、Kimi 等模型
- **儲值福利** — 儲值 ¥1 到帳 $1 平台額度
- **模型折扣** — 部分線路按折扣計費，具體以模型廣場為準
- **OpenAI Compatible** — 取得 API Key 後可在 ClawPanel 中一鍵接入

在[詞元 API](https://ciyapi.79tian.com/sign-up)註冊並取得 API Key，OpenAI-compatible Base URL 填寫 `https://ciyapi.79tian.com/v1`。模型與價格以[模型廣場](https://ciyapi.79tian.com/pricing/)為準。

### 🔥 開發板 / 嵌入式裝置支援

- **Orange Pi / 樹莓派 / RK3588** — `npm run serve` 即可執行
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — 自動偵測架構
- 無需 Rust / Tauri / GUI；基礎 Web 後端需要 **Node.js 18+**，完整引擎驗證建議使用 Node.js 24.16.0+（24.x），OpenClaw 會按已安裝版本的 `engines.node` 自動檢測

## 社群

一群對 AI Agent 充滿熱情的開發者和玩家，歡迎加入交流。

<p align="center">
  <a href="https://discord.gg/U9AttmsNHh"><strong>Discord</strong></a>
  &nbsp;·&nbsp;
  <a href="https://t.me/clawpanel"><strong>Telegram 群</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/discussions"><strong>Discussions</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/issues/new"><strong>回報 Issue</strong></a>
</p>

## 功能特性

- **🤖 AI 助手（全新）** — 內建 AI 助手，4 種模式 + 8 大工具 + 互動式問答
- **🧩 多引擎架構** — 支援 OpenClaw、Hermes Agent、DeepSeek Harness、OpenCode 與實驗版 Pi，自由切換，各自獨立管理
- **🤖 Hermes Agent 對話** — 內建 Hermes Agent 聊天介面，支援工具呼叫視覺化、檔案系統存取開關、SSE 串流輸出
- **🖼️ 圖片辨識** — 貼上截圖或拖曳圖片，AI 自動辨識分析
- **儀表板** — 系統概覽，即時服務狀態監控，快捷操作
- **服務管理** — OpenClaw / Hermes Gateway 啟停控制、版本偵測與一鍵升級
- **模型設定** — 多服務商管理、批次連通性測試、拖曳排序、自動儲存
- **閘道設定** — 埠口、存取權限、認證 Token、Tailscale
- **訊息頻道** — 統一管理 Telegram、Discord、飛書、釘釘、QQ
- **通訊與自動化** — 訊息設定、廣播策略、Webhook、執行審批
- **使用情況** — Token 用量、API 費用、模型/服務商排行
- **Agent 管理** — Agent 增刪改查、身分編輯、工作區管理
- **聊天** — 串流回應、Markdown 渲染、對話管理
- **定時任務** — Cron 定時執行，多頻道投遞
- **日誌檢視** — 多來源即時日誌與關鍵字搜尋
- **記憶管理** — 記憶檔案檢視/編輯、ZIP 匯出、Agent 切換
- **詞元 API 贊助推廣** — 支援 GPT、Claude 等模型，儲值 ¥1 到帳 $1 平台額度
- **擴充工具** — cftunnel 隧道管理、ClawApp 狀態監控
- **關於** — 版本資訊、社群入口、相關專案連結

## 下載安裝

前往 [官網下載中心](https://claw.qt.cool/download) 下載最新版本；GitHub Releases 保留為備用下載入口：

| 平台 | 安裝檔 |
|------|--------|
| **Windows** | `.exe` 安裝程式（推薦）或 `.msi` |
| **macOS Apple Silicon** | `.dmg` (aarch64) |
| **macOS Intel** | `.dmg` (x64) |
| **Linux** | `.AppImage` / `.deb` / `.rpm` |

### Linux 伺服器（Web 版）

```bash
curl -fsSL https://raw.githubusercontent.com/qingchencloud/clawpanel/main/scripts/linux-deploy.sh | bash
```

### Docker

```bash
docker run -d --name clawpanel --restart unless-stopped \
  -p 1420:1420 -v clawpanel-data:/root/.openclaw \
  node:24.16.0-slim \
  sh -c "apt-get update && apt-get install -y git && \
    npm install -g openclaw@2026.9.8 --registry https://registry.npmmirror.com && \
    git clone https://github.com/qingchencloud/clawpanel.git /app && \
    cd /app && npm ci && npm run build && npm run serve"
```

## 快速上手

1. **初始設定** — 首次啟動自動偵測 Node.js、Git、OpenClaw。未安裝則一鍵安裝
2. **設定模型** — 新增 AI 服務商（DeepSeek、OpenAI、Ollama 等），測試連線
3. **啟動 Gateway** — 前往服務管理，點擊「啟動」。綠色狀態 = 就緒
4. **開始聊天** — 前往即時聊天，選擇模型後開始對話

## 🤖 AI 助手亮點

可**直接操作系統**的 AI 助手 — 診斷、修復、甚至提交 PR。

### 四種模式

| 模式 | 工具 | 寫入檔案 | 確認 | 適用場景 |
|------|------|---------|------|---------|
| **聊天** 💬 | ❌ | ❌ | — | 純問答 |
| **規劃** 📋 | ✅ | ❌ | ✅ | 讀取設定/日誌，輸出方案 |
| **執行** ⚡ | ✅ | ✅ | ✅ | 正常作業，危險操作需確認 |
| **無限** ∞ | ✅ | ✅ | ❌ | 全自動 |

## 技術架構

| 層級 | 技術 | 說明 |
|------|------|------|
| 前端 | Vanilla JS + Vite | 零框架依賴，輕量 |
| 後端 | Rust + Tauri v2 | 原生效能，跨平台 |
| 通訊 | Tauri IPC + Shell Plugin | 前後端橋接 |
| 樣式 | Pure CSS (CSS Variables) | 暗色/亮色主題 |

## 從原始碼建置

```bash
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel && npm install

# 桌面版（需要 Rust + Tauri v2）
npm run tauri dev        # 開發
npm run tauri build      # 正式版

# 僅 Web（無需 Rust）
npm run dev              # 熱更新開發
npm run build && npm run serve  # 正式版
```

國內網路可使用 AtomGit 鏡像：

```bash
git clone https://atomgit.com/qingchencloud/clawpanel.git
```

## 相關專案

| 專案 | 說明 |
|------|------|
| [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) | AI Agent 框架 |
| [ClawApp](https://github.com/qingchencloud/clawapp) | 跨平台行動聊天客戶端 |
| [cftunnel](https://github.com/qingchencloud/cftunnel) | Cloudflare Tunnel 工具 |

## 貢獻

歡迎提交 Issue 和 Pull Request。詳見 [CONTRIBUTING.md](CONTRIBUTING.md)。


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

## 授權條款

[AGPL-3.0](LICENSE) 開源授權。商用需求請聯繫取得商業授權。

© 2026 QingchenCloud | [claw.qt.cool](https://claw.qt.cool)
