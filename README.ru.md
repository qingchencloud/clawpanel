<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  Мульти-движковая панель AI-агентов со встроенным ИИ-ассистентом — OpenClaw, Hermes, DSH, OpenCode и Pi
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> | <a href="README.en.md">🇺🇸 English</a> | <a href="README.zh-TW.md">🇹🇼 繁體中文</a> | <a href="README.ja.md">🇯🇵 日本語</a> | <a href="README.ko.md">🇰🇷 한국어</a> | <a href="README.vi.md">🇻🇳 Tiếng Việt</a> | <a href="README.es.md">🇪🇸 Español</a> | <a href="README.pt.md">🇧🇷 Português</a> | <strong>🇷🇺 Русский</strong> | <a href="README.fr.md">🇫🇷 Français</a> | <a href="README.de.md">🇩🇪 Deutsch</a>
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

ClawPanel — это визуальная панель для нескольких фреймворков AI-агентов: [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation), [Hermes Agent](https://github.com/nousresearch/hermes-agent), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [OpenCode](https://github.com/anomalyco/opencode) и экспериментального [Pi](https://github.com/earendil-works/pi). Встроенный интеллектуальный ИИ-ассистент помогает устанавливать, диагностировать конфигурации и устранять неполадки.

> 🌐 **Сайт**: [claw.qt.cool](https://claw.qt.cool/) | 📦 **Скачать**: [официальный центр загрузки](https://claw.qt.cool/download) | Резерв: [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest)

### 🧪 Бесплатное тестирование: QingChen Cloud

[QingChen Cloud](https://gpt.qt.cool/) — платформа тестирования ClawPanel с ежедневной отметкой. ClawPanel не содержит встроенный ключ QingChen Cloud и не считывает старые ключи автоматически. Зарегистрируйтесь, получите тестовый лимит и собственный API Key на [странице отметки](https://gpt.qt.cool/checkin), затем вставьте его в ClawPanel для настройки моделей. Текущие условия опубликованы на QingChen Cloud.

### 🤝 Спонсор: CiyAPI

> Стороннее спонсорское размещение; действуют актуальные правила, опубликованные CiyAPI.

<p align="center">
  <a href="https://ciyapi.79tian.com" rel="sponsored noopener noreferrer"><img src="https://img.shields.io/badge/🤝 CiyAPI-Sponsored-6366f1?style=for-the-badge" alt="Спонсорский сервис CiyAPI"></a>
</p>

- **Передовые модели** — GPT, Claude, Gemini, Grok, Kimi и другие
- **Бонус пополнения** — ¥1 пополнения даёт $1 кредита на использование
- **Скидочные маршруты** — Для части маршрутов действует скидочная цена
- **Совместимость с OpenAI** — Получите API Key и подключите его через ClawPanel

Зарегистрируйтесь в [CiyAPI](https://ciyapi.79tian.com/sign-up), создайте API Key и используйте `https://ciyapi.79tian.com/v1` как Base URL. Текущие модели и цены доступны в [каталоге моделей](https://ciyapi.79tian.com/pricing/).

### 🔥 Поддержка плат разработки / Встраиваемых устройств

- **Orange Pi / Raspberry Pi / RK3588** — `npm run serve` для запуска
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — Автоопределение архитектуры
- Rust / Tauri / GUI не нужны. Базовый Web требует **Node.js 18+**; для проверки всех движков рекомендуется Node.js 24.16.0+ (24.x). OpenClaw проверяется по требованию `engines.node` установленной версии.

## Сообщество

Сообщество увлечённых разработчиков и пользователей AI-агентов — присоединяйтесь!

<p align="center">
  <a href="https://discord.gg/U9AttmsNHh"><strong>Discord</strong></a>
  &nbsp;·&nbsp;
  <a href="https://t.me/clawpanel"><strong>Telegram</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/discussions"><strong>Discussions</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/issues/new"><strong>Сообщить об Issue</strong></a>
</p>

## Возможности

- **🤖 ИИ-ассистент (Новый)** — Встроенный ИИ-ассистент, 4 режима + 8 инструментов + интерактивный Q&A
- **🧩 Мульти-движковая архитектура** — Поддержка OpenClaw, Hermes Agent, DeepSeek Harness, OpenCode и экспериментального Pi, свободное переключение и независимое управление
- **🤖 Чат Hermes Agent** — Встроенный интерфейс чата Hermes Agent, визуализация вызовов инструментов, доступ к файлам, SSE стриминг
- **🖼️ Распознавание изображений** — Вставьте скриншот или перетащите изображение, ИИ автоматически анализирует
- **Панель мониторинга** — Обзор системы, мониторинг сервисов в реальном времени
- **Управление сервисами** — Запуск/остановка OpenClaw / Hermes Gateway, обнаружение версии и обновление
- **Настройка моделей** — Управление несколькими провайдерами, пакетное тестирование подключения, сортировка перетаскиванием
- **Настройка Gateway** — Порт, область доступа, токен аутентификации, Tailscale
- **Каналы сообщений** — Единое управление Telegram, Discord, Feishu, DingTalk, QQ
- **Коммуникация и автоматизация** — Настройки сообщений, рассылка, Webhooks, утверждение выполнения
- **Аналитика использования** — Использование токенов, расходы API, рейтинги моделей/провайдеров
- **Управление агентами** — CRUD агентов, редактирование идентичности, управление workspace
- **Чат** — Потоковая передача, рендеринг Markdown, управление сессиями
- **Запланированные задачи** — Выполнение по расписанию Cron, многоканальная доставка
- **Просмотр логов** — Логи в реальном времени из нескольких источников и поиск
- **Управление памятью** — Просмотр/редактирование файлов памяти, экспорт ZIP, переключение агентов
- **Спонсорство CiyAPI** — GPT, Claude и другие модели; ¥1 даёт $1 кредита на использование
- **Расширения** — Управление туннелями cftunnel, мониторинг ClawApp
- **О программе** — Информация о версии, ссылки сообщества, связанные проекты

## Скачать и установить

Перейдите в [официальный центр загрузки](https://claw.qt.cool/download) за последней версией. GitHub Releases остается резервным вариантом:

| Платформа | Установщик |
|----------|-----------|
| **Windows** | `.exe` (рекомендуется) или `.msi` |
| **macOS Apple Silicon** | `.dmg` (aarch64) |
| **macOS Intel** | `.dmg` (x64) |
| **Linux** | `.AppImage` / `.deb` / `.rpm` |

### Linux сервер (Web-версия)

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

## Быстрый старт

1. **Начальная настройка** — При первом запуске автоопределение Node.js, Git, OpenClaw. Установка одним кликом при необходимости
2. **Настройка моделей** — Добавить провайдеров ИИ (DeepSeek, OpenAI, Ollama и др.) и протестировать подключение
3. **Запуск Gateway** — Перейти в Управление сервисами, нажать «Запустить». Зелёный статус = готово
4. **Начать чат** — Перейти в Чат, выбрать модель и начать разговор

## Техническая архитектура

| Уровень | Технология | Описание |
|---------|-----------|----------|
| Frontend | Vanilla JS + Vite | Без фреймворков, лёгкий |
| Backend | Rust + Tauri v2 | Нативная производительность, кроссплатформенность |
| Коммуникация | Tauri IPC + Shell Plugin | Мост frontend-backend |
| Стили | Pure CSS (CSS Variables) | Тёмная/светлая темы |

## Сборка из исходного кода

```bash
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel && npm install

# Десктоп (требуется Rust + Tauri v2)
npm run tauri dev        # Разработка
npm run tauri build      # Продакшн

# Только Web (без Rust)
npm run dev              # Hot reload
npm run build && npm run serve  # Продакшн
```

## Связанные проекты

| Проект | Описание |
|--------|----------|
| [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) | Фреймворк AI-агентов |
| [ClawApp](https://github.com/qingchencloud/clawapp) | Кроссплатформенный мобильный чат |
| [cftunnel](https://github.com/qingchencloud/cftunnel) | Инструмент Cloudflare Tunnel |

## Вклад

Issues и Pull Requests приветствуются. См. [CONTRIBUTING.md](CONTRIBUTING.md).


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

## Лицензия

[AGPL-3.0](LICENSE). Для коммерческого использования обращайтесь за коммерческой лицензией.

© 2026 QingchenCloud | [claw.qt.cool](https://claw.qt.cool)
