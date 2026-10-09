<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  Painel multi-motor de AI Agents com Assistente IA integrado — OpenClaw, Hermes, DSH, OpenCode e Pi
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> | <a href="README.en.md">🇺🇸 English</a> | <a href="README.zh-TW.md">🇹🇼 繁體中文</a> | <a href="README.ja.md">🇯🇵 日本語</a> | <a href="README.ko.md">🇰🇷 한국어</a> | <a href="README.vi.md">🇻🇳 Tiếng Việt</a> | <a href="README.es.md">🇪🇸 Español</a> | <strong>🇧🇷 Português</strong> | <a href="README.ru.md">🇷🇺 Русский</a> | <a href="README.fr.md">🇫🇷 Français</a> | <a href="README.de.md">🇩🇪 Deutsch</a>
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

ClawPanel é um painel visual para vários frameworks de AI Agent: [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation), [Hermes Agent](https://github.com/nousresearch/hermes-agent), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [OpenCode](https://github.com/anomalyco/opencode) e o [Pi](https://github.com/earendil-works/pi) experimental. Possui um **assistente IA inteligente integrado** para instalação, diagnóstico de configuração e resolução de problemas.

> 🌐 **Website**: [claw.qt.cool](https://claw.qt.cool/) | 📦 **Download**: [Centro de download oficial](https://claw.qt.cool/download) | Fallback: [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest)

### 🧪 Teste gratuito: QingChen Cloud

[QingChen Cloud](https://gpt.qt.cool/) é a plataforma de testes com check-in do ClawPanel. O ClawPanel não inclui nem lê automaticamente chaves do QingChen Cloud. Cadastre-se, acesse a [página de check-in](https://gpt.qt.cool/checkin) para obter crédito de teste e sua própria API Key, e cole-a no ClawPanel para configurar os modelos. A disponibilidade e as regras atuais são exibidas no QingChen Cloud.

### 🤝 Patrocinado: CiyAPI

> Promoção patrocinada por terceiros; valem as regras atuais publicadas pelo CiyAPI.

<p align="center">
  <a href="https://ciyapi.79tian.com" rel="sponsored noopener noreferrer"><img src="https://img.shields.io/badge/🤝 CiyAPI-Sponsored-6366f1?style=for-the-badge" alt="Serviço patrocinado CiyAPI"></a>
</p>

- **Modelos de ponta** — GPT, Claude, Gemini, Grok, Kimi e outros
- **Benefício de recarga** — Recarregue ¥1 e receba $1 em crédito de uso
- **Rotas com desconto** — Algumas rotas têm preços reduzidos; consulte o mercado de modelos
- **Compatível com OpenAI** — Obtenha uma API Key e conecte pelo ClawPanel

Cadastre-se no [CiyAPI](https://ciyapi.79tian.com/sign-up), crie uma API Key e use `https://ciyapi.79tian.com/v1` como Base URL. Consulte o [mercado de modelos](https://ciyapi.79tian.com/pricing/) para modelos e preços atuais.

### 🔥 Suporte a placas de desenvolvimento / Dispositivos embarcados

- **Orange Pi / Raspberry Pi / RK3588** — `npm run serve` para executar
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — Detecção automática de arquitetura
- Sem necessidade de Rust / Tauri / GUI. O Web básico requer **Node.js 18+**; para validar todos os motores, recomenda-se Node.js 24.16.0+ (24.x). O OpenClaw é validado conforme seu requisito `engines.node`.

## Comunidade

Uma comunidade de desenvolvedores e entusiastas apaixonados por AI Agents — junte-se!

<p align="center">
  <a href="https://discord.gg/U9AttmsNHh"><strong>Discord</strong></a>
  &nbsp;·&nbsp;
  <a href="https://t.me/clawpanel"><strong>Telegram</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/discussions"><strong>Discussions</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/issues/new"><strong>Reportar Issue</strong></a>
</p>

## Funcionalidades

- **🤖 Assistente IA (Novo)** — Assistente IA integrado, 4 modos + 8 ferramentas + Q&A interativo
- **🧩 Arquitetura multi-motor** — Suporta OpenClaw, Hermes Agent, DeepSeek Harness, OpenCode e Pi experimental, comutação livre e gestão independente
- **🤖 Chat Hermes Agent** — Interface de chat Hermes Agent integrada, visualização de chamadas de ferramentas, acesso a arquivos, streaming SSE
- **🖼️ Reconhecimento de imagens** — Cole capturas ou arraste imagens, IA analisa automaticamente
- **Painel** — Visão geral do sistema, monitoramento de serviços em tempo real
- **Gestão de serviços** — Iniciar/parar OpenClaw / Hermes Gateway, detecção de versão e atualização
- **Configuração de modelos** — Gestão multi-provedor, testes de conectividade em lote, ordenação por arrasto
- **Configuração de Gateway** — Porta, escopo de acesso, Token de autenticação, Tailscale
- **Canais de mensagens** — Gestão unificada de Telegram, Discord, Feishu, DingTalk, QQ
- **Comunicação e automação** — Configurações de mensagens, broadcast, Webhooks, aprovação de execução
- **Análise de uso** — Uso de tokens, custos de API, rankings de modelos/provedores
- **Gestão de Agents** — CRUD de Agents, edição de identidade, gestão de workspace
- **Chat** — Streaming, renderização Markdown, gestão de sessões
- **Tarefas agendadas** — Execução agendada com Cron, entrega multicanal
- **Visualizador de logs** — Logs em tempo real multi-fonte e busca por palavras-chave
- **Gestão de memória** — Ver/editar arquivos de memória, exportar ZIP, trocar Agent
- **Patrocínio CiyAPI** — GPT, Claude e outros modelos; ¥1 gera $1 em crédito de uso
- **Ferramentas de extensão** — Gestão de túneis cftunnel, monitoramento do ClawApp
- **Sobre** — Informações de versão, links da comunidade, projetos relacionados

## Download e instalação

Acesse o [centro de download oficial](https://claw.qt.cool/download) para a versão mais recente. GitHub Releases continua disponível como fallback:

| Plataforma | Instalador |
|-----------|-----------|
| **Windows** | `.exe` (recomendado) ou `.msi` |
| **macOS Apple Silicon** | `.dmg` (aarch64) |
| **macOS Intel** | `.dmg` (x64) |
| **Linux** | `.AppImage` / `.deb` / `.rpm` |

### Servidor Linux (Versão Web)

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

## Início rápido

1. **Configuração inicial** — Primeira execução detecta automaticamente Node.js, Git, OpenClaw. Instalação com um clique se necessário
2. **Configurar modelos** — Adicionar provedores de IA (DeepSeek, OpenAI, Ollama, etc.) e testar conectividade
3. **Iniciar Gateway** — Ir para Gestão de serviços, clicar em "Iniciar". Status verde = pronto
4. **Começar a conversar** — Ir para Chat ao vivo, selecionar modelo e iniciar conversa

## Arquitetura técnica

| Camada | Tecnologia | Descrição |
|--------|-----------|-----------|
| Frontend | Vanilla JS + Vite | Sem framework, leve |
| Backend | Rust + Tauri v2 | Performance nativa, multiplataforma |
| Comunicação | Tauri IPC + Shell Plugin | Ponte frontend-backend |
| Estilos | Pure CSS (CSS Variables) | Temas escuro/claro |

## Compilar a partir do código-fonte

```bash
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel && npm install

# Desktop (requer Rust + Tauri v2)
npm run tauri dev        # Desenvolvimento
npm run tauri build      # Produção

# Apenas Web (sem Rust)
npm run dev              # Hot reload
npm run build && npm run serve  # Produção
```

## Projetos relacionados

| Projeto | Descrição |
|---------|-----------|
| [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) | Framework AI Agent |
| [ClawApp](https://github.com/qingchencloud/clawapp) | Cliente móvel multiplataforma |
| [cftunnel](https://github.com/qingchencloud/cftunnel) | Ferramenta Cloudflare Tunnel |

## Contribuir

Issues e Pull Requests são bem-vindos. Veja [CONTRIBUTING.md](CONTRIBUTING.md).


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

## Licença

[AGPL-3.0](LICENSE). Contate-nos para licença comercial.

© 2026 QingchenCloud | [claw.qt.cool](https://claw.qt.cool)
