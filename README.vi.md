<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  Bảng quản lý AI Agent đa động cơ với Trợ lý AI tích hợp — OpenClaw, Hermes, DSH, OpenCode và Pi
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> | <a href="README.en.md">🇺🇸 English</a> | <a href="README.zh-TW.md">🇹🇼 繁體中文</a> | <a href="README.ja.md">🇯🇵 日本語</a> | <a href="README.ko.md">🇰🇷 한국어</a> | <strong>🇻🇳 Tiếng Việt</strong> | <a href="README.es.md">🇪🇸 Español</a> | <a href="README.pt.md">🇧🇷 Português</a> | <a href="README.ru.md">🇷🇺 Русский</a> | <a href="README.fr.md">🇫🇷 Français</a> | <a href="README.de.md">🇩🇪 Deutsch</a>
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

ClawPanel là bảng quản lý trực quan cho nhiều AI Agent framework: [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation), [Hermes Agent](https://github.com/nousresearch/hermes-agent), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [OpenCode](https://github.com/anomalyco/opencode) và [Pi](https://github.com/earendil-works/pi) thử nghiệm. Tích hợp **trợ lý AI thông minh** để cài đặt, chẩn đoán cấu hình và xử lý sự cố.

> 🌐 **Website**: [claw.qt.cool](https://claw.qt.cool/) | 📦 **Tải xuống**: [Trung tâm tải xuống chính thức](https://claw.qt.cool/download) | Dự phòng: [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest)

### 🧪 Thử nghiệm miễn phí: QingChen Cloud

[QingChen Cloud](https://gpt.qt.cool/) là nền tảng thử nghiệm điểm danh dành cho ClawPanel. ClawPanel không tích hợp hoặc tự đọc khóa QingChen Cloud. Hãy tự đăng ký, truy cập [trang điểm danh](https://gpt.qt.cool/checkin) để nhận hạn mức thử nghiệm và API Key của bạn, rồi dán vào ClawPanel để cấu hình mô hình. Trạng thái và quy tắc hiện hành được hiển thị trên QingChen Cloud.

### 🤝 Tài trợ: CiyAPI

> Nội dung quảng bá được tài trợ bởi bên thứ ba; áp dụng các quy tắc mới nhất trên trang CiyAPI.

<p align="center">
  <a href="https://ciyapi.79tian.com" rel="sponsored noopener noreferrer"><img src="https://img.shields.io/badge/🤝 CiyAPI-Sponsored-6366f1?style=for-the-badge" alt="CiyAPI sponsored service"></a>
</p>

- **Mô hình tiên tiến** — GPT, Claude, Gemini, Grok, Kimi và nhiều mô hình khác
- **Ưu đãi nạp tiền** — Nạp ¥1 nhận $1 tín dụng sử dụng trên nền tảng
- **Tuyến giảm giá** — Một số tuyến có giá chiết khấu; xem bảng giá mô hình
- **Tương thích OpenAI** — Lấy API Key và kết nối qua ClawPanel

Đăng ký tại [CiyAPI](https://ciyapi.79tian.com/sign-up), tạo API Key và dùng `https://ciyapi.79tian.com/v1` làm Base URL. Xem [bảng giá mô hình](https://ciyapi.79tian.com/pricing/) để biết danh sách và giá hiện tại.

### 🔥 Hỗ trợ Bo mạch phát triển / Thiết bị nhúng

- **Orange Pi / Raspberry Pi / RK3588** — `npm run serve` để chạy
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — Tự động phát hiện kiến trúc
- Không cần Rust / Tauri / GUI. Web cơ bản cần **Node.js 18+**; để kiểm tra đầy đủ các engine nên dùng Node.js 24.16.0+ (24.x). OpenClaw được kiểm tra theo yêu cầu `engines.node` của phiên bản đã cài.

## Cộng đồng

Cộng đồng các nhà phát triển và người dùng đam mê AI Agent — hãy tham gia!

<p align="center">
  <a href="https://discord.gg/U9AttmsNHh"><strong>Discord</strong></a>
  &nbsp;·&nbsp;
  <a href="https://t.me/clawpanel"><strong>Telegram</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/discussions"><strong>Discussions</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/issues/new"><strong>Báo cáo Issue</strong></a>
</p>

## Tính năng

- **🤖 Trợ lý AI (Mới)** — Trợ lý AI tích hợp, 4 chế độ + 8 công cụ + hỏi đáp tương tác
- **🧩 Kiến trúc đa động cơ** — Hỗ trợ OpenClaw, Hermes Agent, DeepSeek Harness, OpenCode và Pi thử nghiệm, chuyển đổi tự do và quản lý độc lập
- **🤖 Hermes Agent Chat** — Giao diện chat Hermes Agent tích hợp, hiển thị công cụ, chuyển đổi truy cập tệp, SSE streaming
- **🖼️ Nhận dạng hình ảnh** — Dán ảnh chụp màn hình hoặc kéo thả hình ảnh, AI tự động phân tích
- **Bảng điều khiển** — Tổng quan hệ thống, giám sát dịch vụ thời gian thực
- **Quản lý dịch vụ** — Khởi động/dừng OpenClaw / Hermes Gateway, phát hiện phiên bản & nâng cấp
- **Cấu hình mô hình** — Quản lý nhiều nhà cung cấp, kiểm tra kết nối hàng loạt, kéo sắp xếp
- **Cấu hình Gateway** — Cổng, phạm vi truy cập, Token xác thực, Tailscale
- **Kênh nhắn tin** — Quản lý thống nhất Telegram, Discord, Feishu, DingTalk, QQ
- **Truyền thông & Tự động hóa** — Cài đặt tin nhắn, phát sóng, Webhook, phê duyệt
- **Phân tích sử dụng** — Sử dụng Token, chi phí API, xếp hạng mô hình/nhà cung cấp
- **Quản lý Agent** — CRUD Agent, chỉnh sửa danh tính, quản lý workspace
- **Trò chuyện** — Streaming, hiển thị Markdown, quản lý phiên
- **Tác vụ định kỳ** — Thực thi theo lịch Cron, gửi đa kênh
- **Xem nhật ký** — Nhật ký thời gian thực đa nguồn và tìm kiếm
- **Quản lý bộ nhớ** — Xem/sửa tệp bộ nhớ, xuất ZIP, chuyển Agent
- **Tài trợ CiyAPI** — GPT, Claude và các mô hình khác; nạp ¥1 nhận $1 tín dụng sử dụng
- **Công cụ mở rộng** — Quản lý tunnel cftunnel, giám sát ClawApp
- **Giới thiệu** — Thông tin phiên bản, liên kết cộng đồng, dự án liên quan

## Tải xuống & Cài đặt

Truy cập [trung tâm tải xuống chính thức](https://claw.qt.cool/download) để tải phiên bản mới nhất. GitHub Releases vẫn là đường dẫn dự phòng:

| Nền tảng | Trình cài đặt |
|----------|--------------|
| **Windows** | `.exe` (khuyến nghị) hoặc `.msi` |
| **macOS Apple Silicon** | `.dmg` (aarch64) |
| **macOS Intel** | `.dmg` (x64) |
| **Linux** | `.AppImage` / `.deb` / `.rpm` |

### Linux Server (Phiên bản Web)

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

## Bắt đầu nhanh

1. **Thiết lập ban đầu** — Lần chạy đầu tự động phát hiện Node.js, Git, OpenClaw. Cài đặt một cú nhấp nếu thiếu
2. **Cấu hình mô hình** — Thêm nhà cung cấp AI (DeepSeek, OpenAI, Ollama, v.v.) và kiểm tra kết nối
3. **Khởi động Gateway** — Vào Quản lý dịch vụ, nhấp "Khởi động". Trạng thái xanh = sẵn sàng
4. **Bắt đầu trò chuyện** — Vào Chat trực tiếp, chọn mô hình và bắt đầu cuộc trò chuyện

## Kiến trúc kỹ thuật

| Lớp | Công nghệ | Mô tả |
|-----|-----------|-------|
| Frontend | Vanilla JS + Vite | Không framework, nhẹ |
| Backend | Rust + Tauri v2 | Hiệu năng native, đa nền tảng |
| Giao tiếp | Tauri IPC + Shell Plugin | Cầu nối frontend-backend |
| Style | Pure CSS (CSS Variables) | Theme tối/sáng |

## Build từ mã nguồn

```bash
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel && npm install

# Desktop (cần Rust + Tauri v2)
npm run tauri dev        # Phát triển
npm run tauri build      # Production

# Chỉ Web (không cần Rust)
npm run dev              # Hot reload
npm run build && npm run serve  # Production
```

## Dự án liên quan

| Dự án | Mô tả |
|-------|-------|
| [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) | Framework AI Agent |
| [ClawApp](https://github.com/qingchencloud/clawapp) | Ứng dụng chat di động đa nền tảng |
| [cftunnel](https://github.com/qingchencloud/cftunnel) | Công cụ Cloudflare Tunnel |

## Đóng góp

Chào đón Issue và Pull Request. Xem [CONTRIBUTING.md](CONTRIBUTING.md).


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

## Giấy phép

[AGPL-3.0](LICENSE). Liên hệ để được cấp phép thương mại.

© 2026 QingchenCloud | [claw.qt.cool](https://claw.qt.cool)
