<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  AI アシスタント内蔵の OpenClaw 管理パネル — ワンクリックでインストール・設定・診断・修復
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> | <a href="README.en.md">🇺🇸 English</a> | <strong>🇯🇵 日本語</strong>
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
  <img src="docs/feature-showcase.gif" width="800" alt="ClawPanel 機能紹介">
</p>

ClawPanel は [OpenClaw](https://openclaw.ai) AI エージェントフレームワークのビジュアル管理パネルです。**AI アシスタントを内蔵**しており、OpenClaw のワンクリックインストール、設定の自動診断、問題のトラブルシューティング、エラーの修復をサポートします。8 つのツール + 4 つのモード + インタラクティブ Q&A で、初心者から上級者まで簡単に管理できます。

> 🌐 **公式サイト**: [claw.qt.cool](https://claw.qt.cool/) | 📦 **ダウンロード**: [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest)

## 機能

### ダッシュボード & モニタリング
- **リアルタイムダッシュボード** — ゲートウェイの状態、バージョン情報、エージェント一覧、モデルプール、サービスの健全性を一目で確認
- **ログビューア** — リアルタイムのゲートウェイログを検索・フィルタリング付きで表示
- **システム診断** — 設定の問題、WebSocket 接続性、ペアリング状態を自動検出

### AI アシスタント（内蔵）
- **8 つの組み込みツール** — ターミナル実行、ファイル読み書き、ディレクトリ参照、Web 検索、URL 取得、システム情報、プロセス管理、ポート確認
- **4 つのモード** — フルオート、セミオート、読み取り専用、チャットのみ
- **ツール呼び出し** — AI がコマンドの実行、ログの読み取り、設定の変更を直接行い、問題を診断・修復
- **QingchenCloud 連携** — パネルユーザー向けの無料モデルアクセス（一部）、有料ユーザーは 2〜3 倍割引でプレミアムモデルを利用可能

### モデル設定
- **マルチプロバイダー** — OpenAI、Anthropic、DeepSeek、Google Gemini、Ollama、SiliconFlow、Volcengine、Alibaba Cloud など
- **ワンクリックモデル追加** — QingchenCloud カタログからモデルを閲覧・選択
- **モデルテスト** — デプロイ前にワンクリックで任意のモデルをテスト
- **プライマリ / フォールバック** — プライマリモデルを設定し、代替モデルへの自動フォールバック

### エージェント管理
- **マルチエージェント** — 独立したワークスペースを持つ複数の AI エージェントを作成・管理
- **アイデンティティ & パーソナリティ** — 各エージェントに名前、絵文字、モデルを設定
- **メモリファイル** — SOUL.md、IDENTITY.md、AGENTS.md ワークスペースファイルを管理
- **ワークスペース分離** — 各エージェントが独自のメモリ、ツール、設定を保持

### メッセージングチャネル
- **QQ Bot** — QQ オープンプラットフォーム経由の QQ ロボット統合
- **Telegram** — Bot Token 認証
- **Discord** — ギルド / チャネル管理付き Bot
- **Feishu / Lark** — WebSocket モードによるエンタープライズメッセージング
- **DingTalk** — Stream モードロボット付きエンタープライズアプリ
- **マルチアカウント** — 異なるアカウントを異なるエージェントに紐付け

### ゲートウェイ & サービス
- **ゲートウェイ制御** — OpenClaw ゲートウェイの起動、停止、再起動
- **自動ガーディアン** — 予期しない終了時にゲートウェイを自動再起動（クールダウン付き）
- **設定エディタ** — 構文検証付き openclaw.json の直接 JSON エディタ
- **バックアップ & リストア** — ワンクリックで設定のバックアップとリストア

### Cron ジョブ
- **スケジュールタスク** — cron ベースのスケジュール AI タスクを作成
- **配信チャネル** — タスク結果をメッセージングチャネルにルーティング
- **エージェント別割り当て** — 特定のエージェントにタスクを割り当て

### セキュリティ
- **アクセスパスワード** — パスワード認証で Web パネルを保護
- **ネットワークプロキシ** — すべてのアウトバウンドリクエストに HTTP/SOCKS プロキシを設定
- **セッション管理** — 有効期限付きのセキュアなセッショントークン

## インストール

### デスクトップアプリ（Windows / macOS / Linux）

最新のインストーラーを [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest) からダウンロード:

| プラットフォーム | ダウンロード |
|----------|----------|
| **Windows** | `.exe` インストーラー（推奨）または `.msi` |
| **macOS Apple Silicon** | `.dmg` (aarch64) |
| **macOS Intel** | `.dmg` (x64) |
| **Linux** | `.AppImage` / `.deb` / `.rpm` |

### Web 版（Rust / Tauri 不要）

ヘッドレスサーバー、Raspberry Pi、ARM ボード、Docker 向け:

```bash
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel
npm install
npm run serve
# ブラウザで http://localhost:1420 を開く
```

### ARM / 組み込みデバイスサポート

ClawPanel は **純粋な Web デプロイメントモード**（GUI 依存ゼロ）を提供し、ARM64 ボードにネイティブ対応しています:

- **Orange Pi / Raspberry Pi / RK3588** — `npm run serve` で実行
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — アーキテクチャを自動検出
- Rust / Tauri / GUI 不要 — **Node.js 18+ のみ必要**

## クイックスタート

1. ClawPanel をインストールして開く
2. 初回起動時に Node.js 環境と OpenClaw CLI を自動検出
3. OpenClaw が未インストールの場合、ワンクリックでインストール（R2 CDN 高速化）
4. インストール後、ダッシュボードが自動的に読み込まれる

> **動作要件**: Node.js 18+（22 LTS 推奨）

## 技術スタック

- **フロントエンド**: Vanilla JS + CSS Custom Properties（フレームワーク依存ゼロ）
- **デスクトップ**: Tauri v2（Rust バックエンド）
- **Web バックエンド**: Node.js（Express 互換 API サーバー）
- **ビルド**: Vite
- **CI/CD**: GitHub Actions（クロスプラットフォームビルド）

## 開発

```bash
# 前提条件: Node.js 22+、Rust ツールチェーン、Tauri CLI

# クローン
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel

# 依存関係のインストール
npm install

# デスクトップ開発（Tauri）
npm run tauri dev

# Web のみの開発
npm run serve
```

## コントリビューション

Issue や Pull Request を歓迎します。コントリビューションガイドラインについては [CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。

## 謝辞

ClawPanel はコミュニティのすべてのコントリビューターのおかげで成長し続けています。プロジェクトの改善にご協力いただき、ありがとうございます。

### コードコントリビューター

Pull Request を提出し、コードベースに直接貢献してくださった開発者の皆様に感謝します:

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

### コミュニティレポーター

Issue の作成、バグの報告、機能の提案をしてくださったコミュニティメンバーに感謝します:

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

> 貢献の記載漏れがありましたら、[Issue を作成](https://github.com/qingchencloud/clawpanel/issues/new)してください。速やかに追加いたします。

## ライセンス

このプロジェクトは [AGPL-3.0](LICENSE) ライセンスの下で公開されています。オープンソース要件なしでの商用 / プロプライエタリ利用については、商用ライセンスについてお問い合わせください。

© 2026 QingchenCloud (武漢晴辰天下網絡科技有限公司) | [claw.qt.cool](https://claw.qt.cool)
