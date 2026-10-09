<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  Panneau multi-moteur d'agents IA avec Assistant IA intégré — OpenClaw, Hermes, DSH, OpenCode et Pi
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> | <a href="README.en.md">🇺🇸 English</a> | <a href="README.zh-TW.md">🇹🇼 繁體中文</a> | <a href="README.ja.md">🇯🇵 日本語</a> | <a href="README.ko.md">🇰🇷 한국어</a> | <a href="README.vi.md">🇻🇳 Tiếng Việt</a> | <a href="README.es.md">🇪🇸 Español</a> | <a href="README.pt.md">🇧🇷 Português</a> | <a href="README.ru.md">🇷🇺 Русский</a> | <strong>🇫🇷 Français</strong> | <a href="README.de.md">🇩🇪 Deutsch</a>
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
  <img src="docs/feature-showcase.gif" width="800" alt="ClawPanel Showcase">
</p>

ClawPanel est un panneau visuel pour plusieurs frameworks d'agents IA : [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation), [Hermes Agent](https://github.com/nousresearch/hermes-agent), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [OpenCode](https://github.com/anomalyco/opencode) et [Pi](https://github.com/earendil-works/pi) en version expérimentale. Il intègre un **assistant IA intelligent** pour installer, diagnostiquer les configurations et résoudre les problèmes.

> 🌐 **Site web** : [claw.qt.cool](https://claw.qt.cool/) | 📦 **Télécharger** : [Centre de téléchargement officiel](https://claw.qt.cool/download) | Secours : [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest)

### 🧪 Test gratuit : QingChen Cloud

[QingChen Cloud](https://gpt.qt.cool/) est la plateforme de test avec pointage de ClawPanel. ClawPanel n'intègre ni ne lit automatiquement de clé QingChen Cloud. Inscrivez-vous, consultez la [page de pointage](https://gpt.qt.cool/checkin) pour obtenir du crédit de test et votre propre API Key, puis collez-la dans ClawPanel pour configurer les modèles. La disponibilité et les règles actuelles sont affichées sur QingChen Cloud.

### 🤝 Sponsorisé : CiyAPI

> Promotion sponsorisée par un tiers ; les règles actuelles publiées par CiyAPI s'appliquent.

<p align="center">
  <a href="https://ciyapi.79tian.com" rel="sponsored noopener noreferrer"><img src="https://img.shields.io/badge/🤝 CiyAPI-Sponsored-6366f1?style=for-the-badge" alt="Service sponsorisé CiyAPI"></a>
</p>

- **Modèles de pointe** — GPT, Claude, Gemini, Grok, Kimi et plus
- **Avantage de recharge** — ¥1 rechargé donne $1 de crédit d'utilisation
- **Routes à prix réduit** — Certaines routes bénéficient de tarifs réduits
- **Compatible OpenAI** — Obtenez une API Key et connectez-la via ClawPanel

Inscrivez-vous sur [CiyAPI](https://ciyapi.79tian.com/sign-up), créez une API Key et utilisez `https://ciyapi.79tian.com/v1` comme Base URL. Consultez le [catalogue des modèles](https://ciyapi.79tian.com/pricing/) pour les modèles et tarifs actuels.

### 🔥 Support cartes de développement / Appareils embarqués

- **Orange Pi / Raspberry Pi / RK3588** — `npm run serve` pour exécuter
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — Détection automatique d'architecture
- Sans Rust / Tauri / GUI. Le Web de base nécessite **Node.js 18+** ; pour valider tous les moteurs, Node.js 24.16.0+ (24.x) est recommandé. OpenClaw est vérifié selon son exigence `engines.node`.

## Communauté

Une communauté de développeurs et d'enthousiastes passionnés par les agents IA — rejoignez-nous !

<p align="center">
  <a href="https://discord.gg/U9AttmsNHh"><strong>Discord</strong></a>
  &nbsp;·&nbsp;
  <a href="https://t.me/clawpanel"><strong>Telegram</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/discussions"><strong>Discussions</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/issues/new"><strong>Signaler un Issue</strong></a>
</p>

## Fonctionnalités

- **🤖 Assistant IA (Nouveau)** — Assistant IA intégré, 4 modes + 8 outils + Q&A interactif
- **🧩 Architecture multi-moteur** — Support d'OpenClaw, Hermes Agent, DeepSeek Harness, OpenCode et Pi expérimental, avec commutation libre et gestion indépendante
- **🤖 Chat Hermes Agent** — Interface de chat Hermes Agent intégrée, visualisation des appels d'outils, accès aux fichiers, streaming SSE
- **🖼️ Reconnaissance d'images** — Collez des captures d'écran ou glissez des images, l'IA analyse automatiquement
- **Tableau de bord** — Vue d'ensemble du système, surveillance des services en temps réel
- **Gestion des services** — Démarrage/arrêt d'OpenClaw / Hermes Gateway, détection de version et mise à jour
- **Configuration des modèles** — Gestion multi-fournisseurs, tests de connectivité par lots, tri par glisser-déposer
- **Configuration du Gateway** — Port, portée d'accès, Token d'authentification, Tailscale
- **Canaux de messagerie** — Gestion unifiée de Telegram, Discord, Feishu, DingTalk, QQ
- **Communication et automatisation** — Paramètres de messages, diffusion, Webhooks, approbation d'exécution
- **Analyse d'utilisation** — Utilisation des tokens, coûts API, classements modèles/fournisseurs
- **Gestion des Agents** — CRUD des Agents, édition d'identité, gestion du workspace
- **Chat** — Streaming, rendu Markdown, gestion des sessions
- **Tâches planifiées** — Exécution planifiée par Cron, livraison multicanal
- **Visionneuse de logs** — Logs en temps réel multi-sources et recherche par mots-clés
- **Gestion de la mémoire** — Voir/éditer les fichiers mémoire, export ZIP, changement d'Agent
- **Sponsoring CiyAPI** — GPT, Claude et autres modèles ; ¥1 donne $1 de crédit d'utilisation
- **Outils d'extension** — Gestion de tunnels cftunnel, surveillance ClawApp
- **À propos** — Informations de version, liens communautaires, projets associés

## Télécharger et installer

Rendez-vous sur le [centre de téléchargement officiel](https://claw.qt.cool/download) pour la dernière version. GitHub Releases reste disponible en secours :

| Plateforme | Installateur |
|-----------|-------------|
| **Windows** | `.exe` (recommandé) ou `.msi` |
| **macOS Apple Silicon** | `.dmg` (aarch64) |
| **macOS Intel** | `.dmg` (x64) |
| **Linux** | `.AppImage` / `.deb` / `.rpm` |

### Serveur Linux (Version Web)

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

## Démarrage rapide

1. **Configuration initiale** — Le premier lancement détecte automatiquement Node.js, Git, OpenClaw. Installation en un clic si nécessaire
2. **Configurer les modèles** — Ajouter des fournisseurs d'IA (DeepSeek, OpenAI, Ollama, etc.) et tester la connectivité
3. **Démarrer le Gateway** — Aller dans Gestion des services, cliquer sur « Démarrer ». Statut vert = prêt
4. **Commencer à discuter** — Aller dans Chat en direct, sélectionner un modèle et commencer la conversation

## Architecture technique

| Couche | Technologie | Description |
|--------|-----------|-------------|
| Frontend | Vanilla JS + Vite | Sans framework, léger |
| Backend | Rust + Tauri v2 | Performance native, multiplateforme |
| Communication | Tauri IPC + Shell Plugin | Pont frontend-backend |
| Styles | Pure CSS (CSS Variables) | Thèmes sombre/clair |

## Compiler depuis les sources

```bash
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel && npm install

# Bureau (nécessite Rust + Tauri v2)
npm run tauri dev        # Développement
npm run tauri build      # Production

# Web uniquement (sans Rust)
npm run dev              # Hot reload
npm run build && npm run serve  # Production
```

## Projets associés

| Projet | Description |
|--------|-------------|
| [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) | Framework d'agents IA |
| [ClawApp](https://github.com/qingchencloud/clawapp) | Client mobile multiplateforme |
| [cftunnel](https://github.com/qingchencloud/cftunnel) | Outil Cloudflare Tunnel |

## Contribuer

Les Issues et Pull Requests sont les bienvenus. Voir [CONTRIBUTING.md](CONTRIBUTING.md).


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

## Licence

[AGPL-3.0](LICENSE). Contactez-nous pour une licence commerciale.

© 2026 QingchenCloud | [claw.qt.cool](https://claw.qt.cool)
