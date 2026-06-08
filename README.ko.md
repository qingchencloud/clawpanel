<p align="center">
  <img src="public/images/logo-brand.png" width="360" alt="ClawPanel">
</p>

<p align="center">
  AI 어시스턴트 내장 OpenClaw & Hermes Agent 관리 패널 — 멀티엔진 AI 프레임워크 관리
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文</a> | <a href="README.en.md">🇺🇸 English</a> | <a href="README.zh-TW.md">🇹🇼 繁體中文</a> | <a href="README.ja.md">🇯🇵 日本語</a> | <strong>🇰🇷 한국어</strong> | <a href="README.vi.md">🇻🇳 Tiếng Việt</a> | <a href="README.es.md">🇪🇸 Español</a> | <a href="README.pt.md">🇧🇷 Português</a> | <a href="README.ru.md">🇷🇺 Русский</a> | <a href="README.fr.md">🇫🇷 Français</a> | <a href="README.de.md">🇩🇪 Deutsch</a>
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
  <img src="docs/feature-showcase.gif" width="800" alt="ClawPanel 기능 쇼케이스">
</p>

ClawPanel은 여러 AI Agent 프레임워크를 지원하는 시각적 관리 패널으로, 현재 [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) 및 [Hermes Agent](https://github.com/nousresearch/hermes-agent) 듀얼 엔진을 지원합니다. **지능형 AI 어시스턴트를 내장**하여 원클릭 설치, 자동 설정 진단, 문제 해결 및 오류 수정을 지원합니다. 8개 도구 + 4가지 모드 + 대화형 Q&A로 초보자부터 전문가까지 쉽게 관리할 수 있습니다.

> 🌐 **웹사이트**: [claw.qt.cool](https://claw.qt.cool/) | 📦 **다운로드**: [공식 다운로드 센터](https://claw.qt.cool/download) | 예비: [GitHub Releases](https://github.com/qingchencloud/clawpanel/releases/latest)

### 🎁 칭천클라우드 AI API

> 내부 기술 테스트 플랫폼, 일부 사용자에게 개방. 매일 출석하여 크레딧 획득.

<p align="center">
  <a href="https://gpt.qt.cool"><img src="https://img.shields.io/badge/🔑 QingchenCloud AI-gpt.qt.cool-6366f1?style=for-the-badge" alt="QingchenCloud AI"></a>
</p>

- **매일 출석 크레딧** — 출석 + 친구 초대로 테스트 크레딧 획득
- **OpenAI 호환 API** — OpenClaw와 원활한 통합
- **리소스 정책** — 속도 제한 + 요청 상한, 피크 시간대 대기열 가능
- **모델 가용성** — 모델/API는 실제 페이지 표시 기준, 버전 전환 가능

> ⚠️ **준수 사항**: 기술 테스트 전용. 불법 사용이나 보안 메커니즘 우회는 금지됩니다. API Key를 안전하게 관리하세요. 규칙은 최신 플랫폼 정책을 따릅니다.

### 🔥 개발 보드 / 임베디드 디바이스 지원

- **Orange Pi / Raspberry Pi / RK3588** — `npm run serve`로 실행
- **Docker ARM64** — `docker run ghcr.io/qingchencloud/openclaw:latest`
- **Armbian / Debian / Ubuntu Server** — 아키텍처 자동 감지
- Rust / Tauri / GUI 불필요 — **Node.js 18+만 있으면 실행 가능**

## 커뮤니티

AI Agent에 열정적인 개발자와 사용자 커뮤니티 — 함께하세요!

<p align="center">
  <a href="https://discord.gg/U9AttmsNHh"><strong>Discord</strong></a>
  &nbsp;·&nbsp;
  <a href="https://t.me/clawpanel"><strong>Telegram</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/discussions"><strong>Discussions</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/qingchencloud/clawpanel/issues/new"><strong>Issue 보고</strong></a>
</p>

## 기능

- **🤖 AI 어시스턴트 (신규)** — 내장 AI 어시스턴트, 4가지 모드 + 8개 도구 + 대화형 Q&A
- **🧩 멀티엔진 아키텍처** — OpenClaw 및 Hermes Agent 듀얼 엔진 지원, 자유롭게 전환, 각각 독립 관리
- **🤖 Hermes Agent 채팅** — 내장 Hermes Agent 채팅 인터페이스, 도구 호출 시각화, 파일 시스템 액세스 토글, SSE 스트리밍
- **🖼️ 이미지 인식** — 스크린샷 붙여넣기 또는 이미지 드래그로 AI 자동 분석
- **대시보드** — 시스템 개요, 실시간 서비스 모니터링, 빠른 작업
- **서비스 관리** — OpenClaw / Hermes Gateway 시작/중지, 버전 감지 및 원클릭 업그레이드
- **모델 설정** — 멀티 프로바이더 관리, 배치 연결 테스트, 드래그 정렬, 자동 저장
- **게이트웨이 설정** — 포트, 접근 범위, 인증 Token, Tailscale
- **메시징 채널** — Telegram, Discord, 飞书, DingTalk, QQ 통합 관리
- **통신 및 자동화** — 메시지 설정, 브로드캐스트, Webhook, 실행 승인
- **사용량 분석** — Token 사용량, API 비용, 모델/프로바이더 순위
- **Agent 관리** — Agent CRUD, 아이덴티티 편집, 워크스페이스 관리
- **채팅** — 스트리밍, Markdown 렌더링, 세션 관리
- **예약 작업** — Cron 기반 예약 실행, 멀티 채널 배달
- **로그 뷰어** — 멀티 소스 실시간 로그 및 키워드 검색
- **메모리 관리** — 메모리 파일 보기/편집, ZIP 내보내기, Agent 전환
- **칭천클라우드 AI API** — 내부 테스트 플랫폼, OpenAI 호환
- **확장 도구** — cftunnel 터널 관리, ClawApp 상태 모니터링
- **정보** — 버전 정보, 커뮤니티 링크, 관련 프로젝트

## 다운로드 및 설치

[공식 다운로드 센터](https://claw.qt.cool/download)에서 최신 버전을 받으세요. GitHub Releases는 예비 다운로드 경로입니다:

| 플랫폼 | 설치 파일 |
|--------|----------|
| **Windows** | `.exe` 설치 프로그램 (권장) 또는 `.msi` |
| **macOS Apple Silicon** | `.dmg` (aarch64) |
| **macOS Intel** | `.dmg` (x64) |
| **Linux** | `.AppImage` / `.deb` / `.rpm` |

### Linux 서버 (Web 버전)

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

## 빠른 시작

1. **초기 설정** — 첫 실행 시 Node.js, Git, OpenClaw 자동 감지. 미설치 시 원클릭 설치
2. **모델 설정** — AI 프로바이더 (DeepSeek, OpenAI, Ollama 등) 추가 및 연결 테스트
3. **Gateway 시작** — 서비스 관리에서 「시작」 클릭. 녹색 상태 = 준비 완료
4. **채팅 시작** — 실시간 채팅에서 모델 선택 후 대화 시작

## 🤖 AI 어시스턴트 하이라이트

시스템을 **직접 조작**할 수 있는 AI 어시스턴트 — 진단, 수정, PR 제출까지.

### 4가지 모드

| 모드 | 도구 | 파일 쓰기 | 확인 | 용도 |
|------|------|----------|------|------|
| **채팅** 💬 | ❌ | ❌ | — | 순수 Q&A |
| **계획** 📋 | ✅ | ❌ | ✅ | 설정/로그 읽기, 계획 출력 |
| **실행** ⚡ | ✅ | ✅ | ✅ | 일반 작업, 위험 작업은 확인 필요 |
| **무제한** ∞ | ✅ | ✅ | ❌ | 완전 자동 |

## 기술 아키텍처

| 계층 | 기술 | 설명 |
|------|------|------|
| 프론트엔드 | Vanilla JS + Vite | 제로 프레임워크, 경량 |
| 백엔드 | Rust + Tauri v2 | 네이티브 성능, 크로스 플랫폼 |
| 통신 | Tauri IPC + Shell Plugin | 프론트엔드-백엔드 브릿지 |
| 스타일 | Pure CSS (CSS Variables) | 다크/라이트 테마 |

## 소스에서 빌드

```bash
git clone https://github.com/qingchencloud/clawpanel.git
cd clawpanel && npm install

# 데스크톱 (Rust + Tauri v2 필요)
npm run tauri dev        # 개발
npm run tauri build      # 프로덕션

# Web만 (Rust 불필요)
npm run dev              # 핫 리로드 개발
npm run build && npm run serve  # 프로덕션
```

## 관련 프로젝트

| 프로젝트 | 설명 |
|---------|------|
| [OpenClaw](https://github.com/1186258278/OpenClawChineseTranslation) | AI Agent 프레임워크 |
| [ClawApp](https://github.com/qingchencloud/clawapp) | 크로스 플랫폼 모바일 채팅 |
| [cftunnel](https://github.com/qingchencloud/cftunnel) | Cloudflare Tunnel 도구 |

## 기여

Issue와 Pull Request를 환영합니다. [CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요.


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

## 라이선스

[AGPL-3.0](LICENSE) 라이선스. 상용 사용은 상용 라이선스 문의 바랍니다.

© 2026 QingchenCloud | [claw.qt.cool](https://claw.qt.cool)
