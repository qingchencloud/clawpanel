# 只构建维护验收环境；候选 Dockerfile 不参与此镜像构建。
FROM node:24.16.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl bash python3 python3-venv libatomic1 \
    && rm -rf /var/lib/apt/lists/*
# 与生产 Web 管理契约一致，实际核验端口所属 PID 和停止，不用端口存在冒充可管理。
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 procps lsof \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /candidate
USER node
