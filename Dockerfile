# =============================================================================
# ClawPanel Dockerfile - 多阶段构建
# 支持 Docker BuildKit，提供优化的生产镜像
# =============================================================================
#
# 构建命令:
#   docker build -t clawpanel .
#   docker build -t clawpanel --build-arg NPM_REGISTRY=https://registry.npmmirror.com .
#
# 或使用 Docker Compose:
#   docker compose up -d
#
# 访问地址: http://localhost:1420
# =============================================================================

# -----------------------------------------------------------------------------
# 阶段 1: 构建阶段 (builder)
# -----------------------------------------------------------------------------
FROM node:22.22.3-alpine AS builder

# 安装构建依赖
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++

WORKDIR /build

# 复制项目文件
COPY package*.json ./
COPY vite.config.js ./
COPY index.html ./
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY src/ ./src/

# 安装依赖并构建
RUN npm ci --prefer-offline --registry https://registry.npmmirror.com && \
    npm run build

# -----------------------------------------------------------------------------
# 阶段 2: 生产阶段 (production)
# -----------------------------------------------------------------------------
FROM node:22.22.3-alpine AS production

# 安装运行时依赖
RUN apk add --no-cache \
    git \
    curl \
    bash \
    tzdata

# 设置时区
ENV TZ=Asia/Shanghai
ENV NODE_ENV=production
ENV HOME=/root
ENV PORT=1420

# 官方 Node 镜像已内置 node 用户（UID/GID 1000），直接复用，避免新版 Alpine 的 GID 冲突。

WORKDIR /app

# 复制构建产物
COPY --from=builder --chown=node:node /build/dist ./dist
COPY --from=builder --chown=node:node /build/scripts ./scripts
COPY --from=builder --chown=node:node /build/package*.json ./
COPY --from=builder --chown=node:node /build/node_modules ./node_modules
COPY --from=builder --chown=node:node /build/src/lib/model-presets.js ./src/lib/model-presets.js

# 安装 OpenClaw CLI（默认官方稳定版；构建参数仍可切换汉化版）
ARG OPENCLAW_PACKAGE=openclaw
ARG OPENCLAW_VERSION=2026.8.2
RUN npm install -g "${OPENCLAW_PACKAGE}@${OPENCLAW_VERSION}" --registry https://registry.npmmirror.com || \
    npm install -g "${OPENCLAW_PACKAGE}@${OPENCLAW_VERSION}" --registry https://registry.npmjs.org

# 创建数据目录
RUN mkdir -p /app/data && \
    chown -R node:node /app

# 暴露端口
EXPOSE 1420

# 使用 root 用户运行（确保能管理 Gateway 等）
# 如需安全性，可切换到 node，但需确保卷挂载权限正确
USER root

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f "http://localhost:${PORT:-1420}/__api/health" || exit 1

# 启动命令
CMD ["node", "scripts/serve.js"]
