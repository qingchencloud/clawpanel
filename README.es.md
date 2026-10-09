<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  Panel multi-motor de AI Agents con Asistente IA integrado — OpenClaw, Hermes, DSH, OpenCode y Pi
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> | <a href="README.en.md">🇺🇸 English</a> | <a href="README.zh-TW.md">🇹🇼 繁體中文</a> | <a href="README.ja.md">🇯🇵 日本語</a> | <a href="README.ko.md">🇰🇷 한국어</a> | <a href="README.vi.md">🇻🇳 Tiếng Việt</a> | <strong>🇪🇸 Español</strong> | <a href="README.pt.md">🇧🇷 Português</a> | <a href="README.ru.md">🇷🇺 Русский</a> | <a href="README.fr.md">🇫🇷 Français</a> | <a href="README.de.md">🇩🇪 Deutsch</a>
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

ClawPanel es un panel visual para varios frameworks de AI Agent: [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation), [Hermes Agent](https://github.com/nousresearch/hermes-agent), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [OpenCode](https://github.com/anomalyco/opencode) y el [Pi](https://github.com/earendil-works/pi) experimental. Incluye un **asistente IA inteligente** para instalar, diagnosticar configuraciones y resolver problemas.

> 🌐 **Sitio web**: [claw.qt.cool](https://claw.qt.cool/) | 📦 **Descargar**: [Centro de descargas oficial](https://claw.qt.cool/download) | Alternativa: [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest)

### 🧪 Pruebas gratuitas: QingChen Cloud

[QingChen Cloud](https://gpt.qt.cool/) es la plataforma de pruebas con registro diario para ClawPanel. ClawPanel no incluye ni lee automáticamente claves de QingChen Cloud. Regístrate, visita la [página de registro](https://gpt.qt.cool/checkin) para obtener crédito de prueba y tu propia API Key, y pégala en ClawPanel para configurar los modelos. La disponibilidad y las reglas vigentes se muestran en QingChen Cloud.

### 🤝 Patrocinado: CiyAPI

> Promoción patrocinada por un tercero; se aplican las reglas actuales publicadas por CiyAPI.

<p align="center">
  <a href="https://ciyapi.79tian.com" rel="sponsored noopener noreferrer"><img src="https://img.shields.io/badge/🤝 CiyAPI-Sponsored-6366f1?style=for-the-badge" alt="Servicio patrocinado CiyAPI"></a>
</p>

- **Modelos de vanguardia** — GPT, Claude, Gemini, Grok, Kimi y más
- **Beneficio de recarga** — Recarga ¥1 y recibe $1 de crédito de uso
- **Rutas con descuento** — Algunas rutas tienen precios con descuento; consulta el mercado de modelos
- **Compatible con OpenAI** — Obtén una API Key y conéctala desde ClawPanel

Regístrate en [CiyAPI](https://ciyapi.79tian.com/sign-up), crea una API Key y usa `https://ciyapi.79tian.com/v1` como Base URL. Consulta el [mercado de modelos](https://ciyapi.79tian.com/pricing/) para ver modelos y precios actuales.

### 🔥 Soporte para placas de desarrollo / Dispositivos embebidos

- **Orange Pi / Raspberry Pi / RK3588** — `npm run serve` para ejecutar
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — Detección automática de arquitectura
- Sin necesidad de Rust / Tauri / GUI. El Web básico requiere **Node.js 18+**; para validar todos los motores se recomienda Node.js 24.16.0+ (24.x). OpenClaw se valida según su requisito `engines.node`.

## Comunidad

Una comunidad de desarrolladores y entusiastas apasionados por los AI Agents — ¡únete!

<p align="center">
  <a href="https://discord.gg/U9AttmsNHh"><strong>Discord</strong></a>
  &nbsp;·&nbsp;
  <a href="https://t.me/clawpanel"><strong>Telegram</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/discussions"><strong>Discussions</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/issues/new"><strong>Reportar Issue</strong></a>
</p>

## Características

- **🤖 Asistente IA (Nuevo)** — Asistente IA integrado, 4 modos + 8 herramientas + Q&A interactivo
- **🧩 Arquitectura multi-motor** — Soporta OpenClaw, Hermes Agent, DeepSeek Harness, OpenCode y Pi experimental, conmutación libre y gestión independiente
- **🤖 Chat Hermes Agent** — Interfaz de chat Hermes Agent integrada, visualización de llamadas a herramientas, acceso a archivos, streaming SSE
- **🖼️ Reconocimiento de imágenes** — Pega capturas o arrastra imágenes, IA analiza automáticamente
- **Panel** — Vista general del sistema, monitoreo de servicios en tiempo real
- **Gestión de servicios** — Inicio/parada de OpenClaw / Hermes Gateway, detección de versión y actualización
- **Configuración de modelos** — Gestión multi-proveedor, pruebas de conectividad por lotes, ordenar arrastrando
- **Configuración de Gateway** — Puerto, alcance de acceso, Token de autenticación, Tailscale
- **Canales de mensajería** — Gestión unificada de Telegram, Discord, Feishu, DingTalk, QQ
- **Comunicación y automatización** — Configuración de mensajes, difusión, Webhooks, aprobación de ejecución
- **Análisis de uso** — Uso de tokens, costos API, rankings de modelos/proveedores
- **Gestión de Agents** — CRUD de Agents, edición de identidad, gestión de workspace
- **Chat** — Streaming, renderizado Markdown, gestión de sesiones
- **Tareas programadas** — Ejecución programada con Cron, entrega multicanal
- **Visor de logs** — Logs en tiempo real multi-fuente y búsqueda por palabras clave
- **Gestión de memoria** — Ver/editar archivos de memoria, exportar ZIP, cambiar Agent
- **Patrocinio CiyAPI** — GPT, Claude y otros modelos; ¥1 aporta $1 de crédito de uso
- **Herramientas de extensión** — Gestión de túneles cftunnel, monitoreo de ClawApp
- **Acerca de** — Información de versión, enlaces de comunidad, proyectos relacionados

## Descargar e instalar

Visita el [centro de descargas oficial](https://claw.qt.cool/download) para la última versión. GitHub Releases sigue disponible como alternativa:

| Plataforma | Instalador |
|-----------|-----------|
| **Windows** | `.exe` (recomendado) o `.msi` |
| **macOS Apple Silicon** | `.dmg` (aarch64) |
| **macOS Intel** | `.dmg` (x64) |
| **Linux** | `.AppImage` / `.deb` / `.rpm` |

### Servidor Linux (Versión Web)

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

## Inicio rápido

1. **Configuración inicial** — Primera ejecución detecta automáticamente Node.js, Git, OpenClaw. Instalación con un clic si falta
2. **Configurar modelos** — Añadir proveedores de IA (DeepSeek, OpenAI, Ollama, etc.) y probar conectividad
3. **Iniciar Gateway** — Ir a Gestión de servicios, clic en "Iniciar". Estado verde = listo
4. **Empezar a chatear** — Ir a Chat en vivo, seleccionar modelo y comenzar conversación

## Arquitectura técnica

| Capa | Tecnología | Descripción |
|------|-----------|-------------|
| Frontend | Vanilla JS + Vite | Sin framework, ligero |
| Backend | Rust + Tauri v2 | Rendimiento nativo, multiplataforma |
| Comunicación | Tauri IPC + Shell Plugin | Puente frontend-backend |
| Estilos | Pure CSS (CSS Variables) | Temas oscuro/claro |

## Compilar desde código fuente

```bash
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel && npm install

# Escritorio (requiere Rust + Tauri v2)
npm run tauri dev        # Desarrollo
npm run tauri build      # Producción

# Solo Web (sin Rust)
npm run dev              # Hot reload
npm run build && npm run serve  # Producción
```

## Proyectos relacionados

| Proyecto | Descripción |
|----------|-------------|
| [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) | Framework AI Agent |
| [ClawApp](https://github.com/qingchencloud/clawapp) | Cliente móvil multiplataforma |
| [cftunnel](https://github.com/qingchencloud/cftunnel) | Herramienta Cloudflare Tunnel |

## Contribuir

Issues y Pull Requests son bienvenidos. Ver [CONTRIBUTING.md](CONTRIBUTING.md).


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

## Licencia

[AGPL-3.0](LICENSE). Contactar para licencia comercial.

© 2026 QingchenCloud | [claw.qt.cool](https://claw.qt.cool)
