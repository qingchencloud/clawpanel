<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  AI アシスタント内蔵の OpenClaw & Hermes Agent 管理パネル — マルチエンジン AI フレームワーク管理
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> | <a href="README.en.md">🇺🇸 English</a> | <a href="README.zh-TW.md">🇹🇼 繁體中文</a> | <strong>🇯🇵 日本語</strong> | <a href="README.ko.md">🇰🇷 한국어</a> | <a href="README.vi.md">🇻🇳 Tiếng Việt</a> | <a href="README.es.md">🇪🇸 Español</a> | <a href="README.pt.md">🇧🇷 Português</a> | <a href="README.ru.md">🇷🇺 Русский</a> | <a href="README.fr.md">🇫🇷 Français</a> | <a href="README.de.md">🇩🇪 Deutsch</a>
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
  <img src="docs/feature-showcase.gif" width="800" alt="ClawPanel 機能ショーケース">
</p>

ClawPanel は複数の AI Agent フレームワークをサポートするビジュアル管理パネルで、現在 [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) と [Hermes Agent](https://github.com/nousresearch/hermes-agent) のデュアルエンジンをサポートしています。**インテリジェント AI アシスタントを内蔵**し、ワンクリックインストール、設定の自動診断、問題の特定と修復をサポートします。8 つのツール + 4 つのモード + インタラクティブ Q&A で、初心者からエキスパートまで簡単に管理できます。

> 🌐 **ウェブサイト**: [claw.qt.cool](https://claw.qt.cool/) | 📦 **ダウンロード**: [公式ダウンロードセンター](https://claw.qt.cool/download) | 予備: [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest)

### 🎁 晴辰クラウド AI API

> 内部技術テストプラットフォーム、一部のユーザーに開放。毎日サインインでクレジット獲得。

<p align="center">
  <a href="https://gpt.qt.cool"><img src="https://img.shields.io/badge/🔑 QingchenCloud AI-gpt.qt.cool-6366f1?style=for-the-badge" alt="QingchenCloud AI"></a>
</p>

- **毎日サインインクレジット** — サインイン + 友達招待でテストクレジット獲得
- **OpenAI 互換 API** — OpenClaw とシームレスに統合
- **リソースポリシー** — レート制限 + リクエスト上限、ピーク時はキュー待ち
- **モデル可用性** — モデル/API は実際のページ表示に準拠、バージョン切替の場合あり

> ⚠️ **コンプライアンス**: 技術テスト専用。違法使用やセキュリティメカニズムの回避は禁止。API Key は安全に管理してください。ルールは最新のプラットフォームポリシーに準拠します。

### 🔥 開発ボード / 組み込みデバイスサポート

- **Orange Pi / Raspberry Pi / RK3588** — `npm run serve` で実行
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — アーキテクチャ自動検出
- Rust / Tauri / GUI 不要 — **Node.js 18+ のみで動作**

## コミュニティ

AI Agent に情熱を持つ開発者とユーザーのコミュニティ — ぜひご参加ください！

<p align="center">
  <a href="https://discord.gg/U9AttmsNHh"><strong>Discord</strong></a>
  &nbsp;·&nbsp;
  <a href="https://t.me/clawpanel"><strong>Telegram</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/discussions"><strong>Discussions</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/issues/new"><strong>Issue を報告</strong></a>
</p>

## 機能

- **🤖 AI アシスタント（新機能）** — 内蔵 AI アシスタント、4 モード + 8 ツール + インタラクティブ Q&A
- **🧩 マルチエンジンアーキテクチャ** — OpenClaw と Hermes Agent のデュアルエンジンをサポート、自由に切り替え、それぞれ独立管理
- **🤖 Hermes Agent チャット** — 内蔵 Hermes Agent チャットインターフェース、ツール呼び出しの可視化、ファイルアクセス切り替え、SSE ストリーミング
- **🖼️ 画像認識** — スクリーンショットの貼り付けや画像のドラッグで AI が自動分析
- **ダッシュボード** — システム概要、リアルタイムサービス監視、クイックアクション
- **サービス管理** — OpenClaw / Hermes Gateway の起動/停止、バージョン検出とワンクリックアップグレード
- **モデル設定** — マルチプロバイダー管理、バッチ接続テスト、ドラッグ並び替え、自動保存
- **ゲートウェイ設定** — ポート、アクセス範囲、認証 Token、Tailscale
- **メッセージチャンネル** — Telegram、Discord、飛書、DingTalk、QQ の統合管理
- **通信と自動化** — メッセージ設定、ブロードキャスト、Webhook、実行承認
- **使用状況分析** — Token 使用量、API コスト、モデル/プロバイダーランキング
- **Agent 管理** — Agent の CRUD、アイデンティティ編集、ワークスペース管理
- **チャット** — ストリーミング、Markdown レンダリング、セッション管理
- **定時タスク** — Cron ベースのスケジュール実行、マルチチャンネル配信
- **ログビューア** — マルチソースリアルタイムログとキーワード検索
- **メモリ管理** — メモリファイルの表示/編集、ZIP エクスポート、Agent 切替
- **晴辰クラウド AI API** — 内部テストプラットフォーム、OpenAI 互換
- **拡張ツール** — cftunnel トンネル管理、ClawApp ステータス監視
- **バージョン情報** — バージョン、コミュニティリンク、関連プロジェクト

## ダウンロードとインストール

[公式ダウンロードセンター](https://claw.qt.cool/download) から最新版をダウンロードしてください。GitHub Releases は予備のダウンロード先です：

| プラットフォーム | インストーラー |
|-----------------|---------------|
| **Windows** | `.exe` インストーラー（推奨）または `.msi` |
| **macOS Apple Silicon** | `.dmg` (aarch64) |
| **macOS Intel** | `.dmg` (x64) |
| **Linux** | `.AppImage` / `.deb` / `.rpm` |

### Linux サーバー（Web 版）

```bash
curl -fsSL https://raw.githubusercontent.com/qingchencloud/clawpanel/main/scripts/linux-deploy.sh | bash
```

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

## クイックスタート

1. **初期設定** — 初回起動で Node.js、Git、OpenClaw を自動検出。未インストールならワンクリック
2. **モデル設定** — AI プロバイダー（DeepSeek、OpenAI、Ollama 等）を追加して接続テスト
3. **Gateway 起動** — サービス管理で「起動」をクリック。緑色ステータス = 準備完了
4. **チャット開始** — ライブチャットでモデルを選択して会話開始

## 🤖 AI アシスタントハイライト

システムを**直接操作**できる AI アシスタント — 診断、修復、PR 提出まで。

### 4 つのモード

| モード | ツール | ファイル書込 | 確認 | 用途 |
|--------|--------|-------------|------|------|
| **チャット** 💬 | ❌ | ❌ | — | 純粋な Q&A |
| **計画** 📋 | ✅ | ❌ | ✅ | 設定/ログ読取、計画出力 |
| **実行** ⚡ | ✅ | ✅ | ✅ | 通常作業、危険な操作は確認必要 |
| **無制限** ∞ | ✅ | ✅ | ❌ | 完全自動 |

### 8 つのツール

| ツール | 機能 |
|--------|------|
| `ask_user` | ユーザーへの質問（単一選択/複数選択/テキスト） |
| `get_system_info` | OS、アーキテクチャ、ホームディレクトリ取得 |
| `run_command` | シェルコマンド実行 |
| `read_file` / `write_file` | ファイル読み書き |
| `list_directory` | ディレクトリ閲覧 |
| `list_processes` | プロセス表示 |
| `check_port` | ポート使用状況確認 |

## 技術アーキテクチャ

| レイヤー | 技術 | 説明 |
|---------|------|------|
| フロントエンド | Vanilla JS + Vite | ゼロフレームワーク、軽量 |
| バックエンド | Rust + Tauri v2 | ネイティブ性能、クロスプラットフォーム |
| 通信 | Tauri IPC + Shell Plugin | フロントエンド・バックエンドブリッジ |
| スタイル | Pure CSS (CSS Variables) | ダーク/ライトテーマ |

## ソースからビルド

```bash
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel && npm install

# デスクトップ（Rust + Tauri v2 必要）
npm run tauri dev        # 開発
npm run tauri build      # プロダクション

# Web のみ（Rust 不要）
npm run dev              # ホットリロード開発
npm run build && npm run serve  # プロダクション
```

## 関連プロジェクト

| プロジェクト | 説明 |
|-------------|------|
| [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) | AI Agent フレームワーク |
| [ClawApp](https://github.com/qingchencloud/clawapp) | クロスプラットフォームモバイルチャット |
| [cftunnel](https://github.com/qingchencloud/cftunnel) | Cloudflare Tunnel ツール |

## 貢献

Issue と Pull Request を歓迎します。[CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。


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

## ライセンス

[AGPL-3.0](LICENSE) ライセンス。商用利用については商用ライセンスをお問い合わせください。

© 2026 QingchenCloud | [claw.qt.cool](https://claw.qt.cool)
