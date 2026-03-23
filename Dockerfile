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
FROM node:22-alpine AS builder

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
COPY scripts/ ./scripts/
COPY src/ ./src/

# 安装依赖并构建
RUN npm ci --prefer-offline --registry https://registry.npmmirror.com && \
    npm run build

# -----------------------------------------------------------------------------
# 阶段 2: 生产阶段 (production)
# -----------------------------------------------------------------------------
FROM node:22-alpine AS production

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

# 创建非 root 用户 (可选，主要用于日志查看)
RUN addgroup -g 1000 appgroup && \
    adduser -u 1000 -G appgroup -s /bin/sh -D appuser

WORKDIR /app

# 复制构建产物
COPY --from=builder --chown=appuser:appgroup /build/dist ./dist
COPY --from=builder --chown=appuser:appgroup /build/scripts ./scripts
COPY --from=builder --chown=appuser:appgroup /build/package*.json ./
COPY --from=builder --chown=appuser:appgroup /build/node_modules ./node_modules

# 安装 OpenClaw CLI（用于读写配置）
# 使用国内镜像源加速
RUN npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com || \
    npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmjs.org

# 创建数据目录
RUN mkdir -p /app/data && \
    chown -R appuser:appgroup /app

# 暴露端口
EXPOSE 1420

# 使用 root 用户运行（确保能管理 Gateway 等）
# 如需安全性，可切换到 appuser，但需确保卷挂载权限正确
USER root

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:1420/ || exit 1

# 启动命令
CMD ["node", "scripts/serve.js"]
