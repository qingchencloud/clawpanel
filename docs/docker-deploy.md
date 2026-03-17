# ClawPanel Docker 部署指南

本文介绍如何用 Docker 部署 **ClawPanel Web 版**，通过浏览器远程管理 OpenClaw。

> **ClawPanel** 有 Win/Mac 桌面客户端，但 Linux 没有桌面版。Docker 部署让你在任何有 Docker 的机器上一键跑起 ClawPanel Web 管理面板。

---

## 目录

- [架构说明](#架构说明)
- [方式一：快速启动](#方式一快速启动)
- [方式二：Docker Compose（推荐）](#方式二docker-compose推荐)
- [方式三：自定义 Dockerfile](#方式三自定义-dockerfile)
- [配置与数据](#配置与数据)
- [连接 Gateway](#连接-gateway)
- [Nginx 反向代理](#nginx-反向代理)
- [常用命令](#常用命令)
- [更新升级](#更新升级)
- [常见问题](#常见问题)

---

## 架构说明

```
浏览器 ──HTTP──▶ ClawPanel Web 容器 (:1420)
                        │
                        ├── /__api/*   读写 ~/.openclaw/ 配置
                        ├── /ws        WebSocket 代理 → Gateway
                        └── 管理 Gateway 进程
                              │
                              ▼
              OpenClaw Gateway (容器内或宿主机, :18789)
```

ClawPanel Web 版 = Vite 开发服务器 + `dev-api.js` 后端中间件，在容器内提供完整管理功能。

---

## 方式一：快速启动

最简单的方式，一条命令搞定：

```bash
docker run -d \
  --name clawpanel \
  --restart unless-stopped \
  -p 1420:1420 \
  -v clawpanel-data:/root/.openclaw \
  node:22-slim \
  sh -c "\
    apt-get update && apt-get install -y git && \
    npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com && \
    openclaw init 2>/dev/null || true && \
    git clone https://github.com/qingchencloud/clawpanel.git /app && \
    cd /app && npm install && npm run build && \
    npm run serve"
```

访问 `http://服务器IP:1420` 即可使用。

> ⚠️ 这种方式每次重建容器都要重新 clone + npm install，适合快速体验。生产环境推荐使用 Compose 或自定义镜像。

---

## 方式二：Docker Compose（推荐）

创建 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  clawpanel:
    build:
      context: .
      dockerfile: Dockerfile.clawpanel
    container_name: clawpanel
    restart: unless-stopped
    ports:
      - "1420:1420"
    volumes:
      - openclaw-data:/root/.openclaw
    environment:
      - NODE_ENV=production

  gateway:
    image: node:22-slim
    container_name: openclaw-gateway
    restart: unless-stopped
    ports:
      - "18789:18789"
    volumes:
      - openclaw-data:/root/.openclaw
    command: >
      sh -c "npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com &&
             openclaw init 2>/dev/null || true &&
             openclaw gateway start --foreground"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:18789/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  openclaw-data:
```

同目录下创建 `Dockerfile.clawpanel`：

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN git clone https://github.com/qingchencloud/clawpanel.git . && \
    npm install

EXPOSE 1420

RUN npm run build

CMD ["npm", "run", "serve"]
```

启动：

```bash
docker compose up -d
```

这样 ClawPanel 和 Gateway 共享同一个 `openclaw-data` 卷，ClawPanel 可以直接管理 Gateway。

---

## 方式三：自定义 Dockerfile

如果只需要 ClawPanel Web（Gateway 在宿主机或其他地方运行）：

```dockerfile
FROM node:22-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# 安装 OpenClaw CLI（ClawPanel 需要读写配置）
RUN npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com

WORKDIR /app
RUN git clone https://github.com/qingchencloud/clawpanel.git . && \
    npm install

EXPOSE 1420

RUN npm run build

CMD ["npm", "run", "serve"]
```

构建并运行：

```bash
docker build -t clawpanel .
docker run -d \
  --name clawpanel \
  --restart unless-stopped \
  -p 1420:1420 \
  -v ~/.openclaw:/root/.openclaw \
  clawpanel
```

---

## 配置与数据

### 数据目录

ClawPanel 的所有数据都存储在 `~/.openclaw/` 目录中：

| 文件/目录 | 说明 |
|-----------|------|
| `openclaw.json` | 主配置文件（模型、Gateway、Agent 设置） |
| `mcp.json` | MCP 服务器配置 |
| `logs/` | Gateway 日志 |
| `backups/` | 配置备份 |
| `agents/` | Agent 数据（记忆、工作区） |
| `devices/` | 设备配对信息 |

### 持久化

使用 Docker Volume 或 Bind Mount 持久化数据：

```bash
# Docker Volume（推荐）
-v clawpanel-data:/root/.openclaw

# Bind Mount（方便直接查看文件）
-v ~/.openclaw:/root/.openclaw
```

### 初始配置

首次启动如果没有 `openclaw.json`，可以先在容器内初始化：

```bash
docker exec -it clawpanel openclaw init
```

或者将已有配置挂载进去。

---

## 连接 Gateway

### 场景一：Gateway 在同一个 Compose 中

使用上面的 Compose 配置，ClawPanel 和 Gateway 共享数据卷，ClawPanel 自动通过本地回环连接 Gateway。

### 场景二：Gateway 在宿主机

如果 Gateway 运行在宿主机（不在 Docker 中），ClawPanel 容器需要访问宿主机网络：

```bash
docker run -d \
  --name clawpanel \
  --network host \
  -v ~/.openclaw:/root/.openclaw \
  clawpanel
```

使用 `--network host` 后，容器共享宿主机网络，ClawPanel 可以直接连接 `127.0.0.1:18789`。

### 场景三：Gateway 在远程服务器

修改 `openclaw.json` 中的 Gateway 端口配置，或在 ClawPanel 面板中设置 Gateway 地址。

---

## Nginx 反向代理

如果希望用域名 + HTTPS 访问：

```nginx
server {
    listen 80;
    server_name panel.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:1420;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> **重要：** 必须配置 WebSocket 升级头，否则 ClawPanel 无法通过 `/ws` 连接 Gateway。

---

## 常用命令

```bash
# 查看状态
docker ps | grep clawpanel

# 查看日志
docker logs -f clawpanel

# 进入容器
docker exec -it clawpanel bash

# 重启
docker restart clawpanel

# 停止并删除
docker stop clawpanel && docker rm clawpanel
```

---

## 更新升级

### 更新 ClawPanel

```bash
docker exec -it clawpanel bash -c "cd /app && git pull origin main && npm install"
docker restart clawpanel
```

### 使用 Compose 重建

```bash
docker compose build --no-cache clawpanel
docker compose up -d clawpanel
```

### 更新 OpenClaw

```bash
docker exec -it clawpanel npm install -g @qingchencloud/openclaw-zh@latest --registry https://registry.npmmirror.com
```

---

## 常见问题

### Q: 容器启动后打开面板是空白？

检查容器日志：

```bash
docker logs clawpanel
```

确认看到 `VITE ready` 和 `[dev-api] 开发 API 已启动` 输出。

### Q: 面板里点"安装 OpenClaw"失败 / 拉取不了？

面板中的"安装 OpenClaw"走的是 `npm install -g`（在容器内通过网络下载安装），**不是拉取 Docker 镜像**。失败原因通常是容器网络不通或 npm 源访问慢。

**推荐方案（二选一）：**

1. **使用一体镜像（最简单）**：直接用预装了 OpenClaw + Gateway + ClawPanel 的一体镜像，不需要在面板里点安装：
   ```bash
   docker run -d --name openclaw -p 1420:1420 -p 18789:18789 \
     -v openclaw-data:/root/.openclaw \
     ghcr.io/qingchencloud/openclaw:latest
   ```
   > 一体镜像仓库：[github.com/qingchencloud/openclaw-docker](https://github.com/qingchencloud/openclaw-docker)

2. **在 Dockerfile 中预装**：构建镜像时就安装好 OpenClaw，避免运行时下载：
   ```dockerfile
   FROM node:22-slim
   RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
   # 预装 OpenClaw CLI（使用国内镜像源加速）
   RUN npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com
   # ... 后续 ClawPanel 安装步骤
   ```

**临时方案**：如果容器已经在运行，可以手动进入容器安装：
```bash
docker exec -it clawpanel npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com
```

### Q: 面板显示 "openclaw.json 不存在"？

在容器内初始化 OpenClaw：

```bash
docker exec -it clawpanel openclaw init
```

### Q: Gateway 按钮不工作（Docker 环境）？

容器内管理 Gateway 进程需要特殊权限。推荐方案：

1. **Compose 模式**：Gateway 作为独立容器运行，用 `docker compose restart gateway` 管理
2. **Host 网络模式**：`--network host` 让 ClawPanel 直接管理宿主机进程

### Q: 数据会丢失吗？

只要正确配置了 Volume 挂载（`-v clawpanel-data:/root/.openclaw`），容器删除重建不会丢失数据。

### Q: 与桌面版有什么区别？

| 功能 | 桌面版 (Win/Mac) | Docker Web 版 |
|------|-----------------|---------------|
| 配置管理 | ✅ | ✅ |
| Gateway 管理 | ✅ | ⚠️ 需 host 网络或 Compose |
| 模型测试 | ✅ | ✅ |
| 日志查看 | ✅ | ✅ |
| 备份管理 | ✅ | ✅ |
| Agent 记忆 | ✅ | ✅ |
| ZIP 导出 | ✅ | ❌ |
| 系统托盘 | ✅ | ❌ |
| 自动更新 | ✅ | 手动重建镜像 |
