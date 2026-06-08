<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  Panneau de gestion OpenClaw & Hermes Agent avec Assistant IA intégré — Gestion multi-moteur de frameworks IA
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

ClawPanel est un panneau de gestion visuel supportant plusieurs frameworks d'agents IA, actuellement avec un double support pour [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) et [Hermes Agent](https://github.com/nousresearch/hermes-agent). Il intègre un **assistant IA intelligent** qui vous aide à installer, diagnostiquer automatiquement les configurations, résoudre les problèmes et corriger les erreurs. 8 outils + 4 modes + Q&A interactif — facile à gérer pour débutants et experts.

> 🌐 **Site web** : [claw.qt.cool](https://claw.qt.cool/) | 📦 **Télécharger** : [Centre de téléchargement officiel](https://claw.qt.cool/download) | Secours : [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest)

### 🎁 QingchenCloud AI API

> Plateforme interne de tests techniques, ouverte à certains utilisateurs. Connectez-vous quotidiennement pour gagner des crédits.

<p align="center">
  <a href="https://gpt.qt.cool"><img src="https://img.shields.io/badge/🔑 QingchenCloud AI-gpt.qt.cool-6366f1?style=for-the-badge" alt="QingchenCloud AI"></a>
</p>

- **Crédits de connexion quotidienne** — Connexion quotidienne + invitation d'amis pour gagner des crédits de test
- **API compatible OpenAI** — Intégration transparente avec OpenClaw
- **Politique de ressources** — Limitation de débit + plafond de requêtes, file d'attente possible aux heures de pointe
- **Disponibilité des modèles** — Modèles/APIs selon l'affichage réel de la page, rotation de versions possible

> ⚠️ **Conformité** : Uniquement pour les tests techniques. L'utilisation illégale ou le contournement des mécanismes de sécurité sont interdits. Gardez votre API Key en sécurité. Les règles sont soumises aux dernières politiques de la plateforme.

### 🔥 Support cartes de développement / Appareils embarqués

- **Orange Pi / Raspberry Pi / RK3588** — `npm run serve` pour exécuter
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — Détection automatique d'architecture
- Sans Rust / Tauri / GUI — **seulement Node.js 18+**

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
- **🧩 Architecture multi-moteur** — Support OpenClaw et Hermes Agent en double moteur, commutation libre, gestion indépendante
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
- **QingchenCloud AI API** — Plateforme de tests interne, compatible OpenAI
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
  node:22-slim \
  sh -c "apt-get update && apt-get install -y git && \
    npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com && \
    git clone https://github.com/qingchencloud/clawpanel.git /app && \
    cd /app && npm install && npm run build && npm run serve"
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
