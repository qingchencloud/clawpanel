<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  Painel de gestão OpenClaw & Hermes Agent com Assistente IA integrado — Gestão multi-motor de frameworks IA
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

ClawPanel é um painel de gestão visual que suporta múltiplos frameworks de AI Agent, atualmente com suporte dual para [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) e [Hermes Agent](https://github.com/nousresearch/hermes-agent). Possui um **assistente IA inteligente integrado** que ajuda a instalar, diagnosticar configurações automaticamente, resolver problemas e corrigir erros. 8 ferramentas + 4 modos + Q&A interativo — fácil de gerenciar para iniciantes e especialistas.

> 🌐 **Website**: [claw.qt.cool](https://claw.qt.cool/) | 📦 **Download**: [Centro de download oficial](https://claw.qt.cool/download) | Fallback: [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest)

### 🎁 QingchenCloud AI API

> Plataforma interna de testes técnicos, aberta para usuários selecionados. Faça login diariamente para ganhar créditos.

<p align="center">
  <a href="https://gpt.qt.cool"><img src="https://img.shields.io/badge/🔑 QingchenCloud AI-gpt.qt.cool-6366f1?style=for-the-badge" alt="QingchenCloud AI"></a>
</p>

- **Créditos de login diário** — Login diário + convide amigos para ganhar créditos de teste
- **API compatível com OpenAI** — Integração perfeita com OpenClaw
- **Política de recursos** — Limite de velocidade + limite de requisições, possível fila em horários de pico
- **Disponibilidade de modelos** — Modelos/APIs conforme exibição da página, possível rotação de versões

> ⚠️ **Conformidade**: Apenas para testes técnicos. Uso ilegal ou contornar mecanismos de segurança é proibido. Mantenha sua API Key segura. Regras sujeitas às políticas mais recentes da plataforma.

### 🔥 Suporte a placas de desenvolvimento / Dispositivos embarcados

- **Orange Pi / Raspberry Pi / RK3588** — `npm run serve` para executar
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — Detecção automática de arquitetura
- Sem necessidade de Rust / Tauri / GUI — **apenas Node.js 18+**

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
- **🧩 Arquitetura multi-motor** — Suporta OpenClaw e Hermes Agent dual, comutação livre, gestão independente
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
- **QingchenCloud AI API** — Plataforma de testes interna, compatível com OpenAI
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
  node:22-slim \
  sh -c "apt-get update && apt-get install -y git && \
    npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com && \
    git clone https://github.com/qingchencloud/clawpanel.git /app && \
    cd /app && npm install && npm run build && npm run serve"
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
