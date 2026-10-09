# Armbian / ARM 设备部署指南

ClawPanel 支持在 ARM 开发板（如 Orange Pi、Raspberry Pi、RK3588 等）上运行，通过 **Web 模式** 或 **Docker 模式** 部署，无需图形界面。Web 端可从左侧选择 OpenClaw、Hermes Agent、DeepSeek Harness、OpenCode 或实验版 Pi；各引擎的运行时和资源要求不同。

## 系统要求

| 项目 | 最低要求 | 推荐 |
|------|---------|------|
| 架构 | ARM64 (aarch64) | ARM64 |
| 内存 | 1GB（仅面板） | 2GB+；同时运行 Agent 建议更多 |
| 存储 | 2GB 可用空间 | 4GB+ |
| 系统 | Armbian / Debian / Ubuntu | Armbian 24+ |
| Node.js | 18+ | 基础 Web 后端；完整引擎部署推荐 24.16.0+（24.x），OpenClaw 再按当前版本 `engines.node` 检测 |

> ⚠️ 当前不支持 ARM 32 位 (armv7) 的 Docker 镜像。Web 模式在 armv7 上可用（只要 Node.js 支持）。

## 方式一：Web 模式（推荐）

Web 模式是纯 Node.js 服务，零 GUI 依赖，最适合 ARM 板。

### 一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/qingchencloud/clawpanel/main/scripts/linux-deploy.sh | bash
```

如果 GitHub raw 脚本拉取失败，可暂用以下脚本备用入口：

```bash
curl -fsSL https://gitee.com/QtCodeCreators/clawpanel/raw/main/scripts/linux-deploy.sh | bash
```

### 手动部署

```bash
# 1. 安装 Node.js 24 LTS
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo bash -
sudo apt-get install -y nodejs git

# 2. 克隆项目
git clone https://github.com/qingchencloud/clawpanel.git /opt/clawpanel
cd /opt/clawpanel

# 3. 安装依赖并构建
npm ci --registry https://registry.npmmirror.com
npm run build

# 4. 启动服务
npm run serve -- --port 1420
```

国内网络可将克隆地址换成 AtomGit 镜像：

```bash
git clone https://atomgit.com/qingchencloud/clawpanel.git /opt/clawpanel
```

### 设置开机自启（systemd）

```bash
sudo tee /etc/systemd/system/clawpanel.service << 'EOF'
[Unit]
Description=ClawPanel Web Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/clawpanel
ExecStart=/usr/bin/node scripts/serve.js --port 1420
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now clawpanel
```

访问 `http://<板子IP>:1420` 即可使用。

## 方式二：Docker 模式

仓库 Dockerfile 使用多架构 Node 基础镜像；ARM64 板子可以本地构建。当前文档不把第三方或旧的一体镜像当作 ClawPanel 官方多引擎镜像。

```bash
# 安装 Docker（如果还没有）
curl -fsSL https://get.docker.com | sh

# 构建并启动 ClawPanel Web（默认包含 OpenClaw 官方稳定版）
git clone https://github.com/qingchencloud/clawpanel.git /opt/clawpanel
cd /opt/clawpanel
docker build --platform linux/arm64 -t clawpanel:local .
docker run -d \
  --name clawpanel \
  -v openclaw-data:/root/.openclaw \
  --restart unless-stopped \
  --network host \
  clawpanel:local
```

## 性能优化建议

1. **内存不足时**：关闭不需要的系统服务，或增加 swap
   ```bash
   sudo fallocate -l 1G /swapfile
   sudo chmod 600 /swapfile
   sudo mkswap /swapfile
   sudo swapon /swapfile
   echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab
   ```

2. **SD 卡寿命**：日志文件较多时，考虑将日志目录挂载到 tmpfs
   ```bash
   echo 'tmpfs /tmp tmpfs defaults,noatime,size=256m 0 0' | sudo tee -a /etc/fstab
   ```

3. **网络**：AI 计算在云端完成，板子只需稳定网络连接即可。建议使用有线以太网。

## 常见问题

**Q: Tauri 桌面版能在 ARM 板上运行吗？**
A: 不建议。Tauri 需要 WebKitGTK + 图形界面，ARM 板通常是 headless 环境。请使用 Web 模式。

**Q: armv7 (32位) 板子能用吗？**
A: 仅基础 Web 面板是否能运行取决于 Node.js 和依赖的架构支持；OpenClaw、Pi 等引擎还要满足各自运行时要求。本文的 Docker 构建目标是 arm64，不把 armv7 作为完整引擎验收目标。

**Q: 树莓派 Zero / Pi 1 能跑吗？**
A: 这些是 armv6，内存也只有 256-512MB，不推荐。建议至少树莓派 3B+ 或更新的 ARM64 板子。
