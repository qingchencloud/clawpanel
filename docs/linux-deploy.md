# ClawPanel Linux 部署指南

本文介绍如何在 Linux 服务器上部署 **ClawPanel Web 版**，通过浏览器远程管理 OpenClaw。

适用场景：云服务器、NAS、家庭 HomeLab、无 GUI 的 Linux 主机。

> **ClawPanel** 有 Win/Mac 桌面客户端，但 Linux 没有桌面版。Web 版通过 Vite + Node.js 后端运行，功能与桌面版一致。

---

## 目录

- [架构说明](#架构说明)
- [前提条件](#前提条件)
- [方式一：一键部署](#方式一一键部署)
- [方式二：手动部署](#方式二手动部署)
- [方式三：Docker 部署](#方式三docker-部署)
- [访问 ClawPanel](#访问-clawpanel)
- [进程守护](#进程守护)
- [Nginx 反向代理](#nginx-反向代理)
- [防火墙配置](#防火墙配置)
- [更新升级](#更新升级)
- [常见问题](#常见问题)

---

## 架构说明

```
浏览器 ──HTTP──▶ ClawPanel Web (Vite + dev-api 后端, :1420)
                        │
                        ├── /__api/*  读写 ~/.openclaw/ 配置文件
                        ├── /ws       WebSocket 代理 → Gateway
                        └── 管理 Gateway 进程 (启动/停止/重启)
                              │
                              ▼
                    OpenClaw Gateway (:18789)
```

**ClawPanel Web 版** = Vite 开发服务器 + `dev-api.js` 后端中间件，提供：
- 配置读写（`openclaw.json`、`mcp.json`）
- Gateway 服务管理（启动/停止/重启/状态检测）
- 设备配对、模型测试、日志查看、备份管理
- WebSocket 代理到 Gateway

---

## 前提条件

| 依赖 | 最低版本 | 说明 |
|------|----------|------|
| Node.js | 18+ | 推荐 22 LTS |
| npm | 随 Node.js | 包管理器 |
| Git | 任意 | 克隆仓库 |
| OpenClaw | 最新 | ClawPanel 管理的对象 |

---

## 方式一：一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/qingchencloud/clawpanel/main/scripts/linux-deploy.sh | bash
```

脚本自动完成：
1. 检测系统、安装 Node.js（如果缺少）
2. 安装 OpenClaw 汉化版（如果缺少）
3. 克隆 ClawPanel 仓库、安装依赖
4. 创建 systemd 服务、开机自启
5. 启动 ClawPanel Web，输出访问地址

部署完成后访问 `http://服务器IP:1420`。

---

## 方式二：手动部署

### 1. 安装 Node.js

**Ubuntu / Debian：**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**CentOS / RHEL / Fedora：**

```bash
curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
sudo yum install -y nodejs
```

**Alpine：**

```bash
apk add nodejs npm git
```

验证安装：

```bash
node -v   # v22.x.x
npm -v    # 10.x.x
```

### 2. 安装 OpenClaw

ClawPanel 是 OpenClaw 的管理工具，需要先安装 OpenClaw：

```bash
npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com
```

初始化配置（首次）：

```bash
openclaw init
```

### 3. 克隆 ClawPanel

```bash
cd /opt
sudo git clone https://github.com/qingchencloud/clawpanel.git
sudo chown -R $(whoami) clawpanel
cd clawpanel
npm install
```

### 4. 构建并启动 ClawPanel Web

```bash
npm run build    # 构建生产版前端
npm run serve    # 启动 Web 服务器 (默认 0.0.0.0:1420)
```

自定义端口：

```bash
npm run serve -- --port 8080
```

看到以下输出即为成功：

```
  ┌─────────────────────────────────────────┐
  │   ClawPanel Web Server (Headless)      │
  │   http://localhost:1420/                │
  └─────────────────────────────────────────┘
  [api] API 已启动，配置目录: /root/.openclaw
```

打开浏览器访问 `http://服务器IP:1420` 即可使用 ClawPanel。

---

## 方式三：Docker 部署

> Docker 完整教程（Compose、自定义镜像、数据持久化等）见 [Docker 部署指南](docker-deploy.md)

快速启动：

```bash
docker run -d \
  --name clawpanel \
  --restart unless-stopped \
  -p 1420:1420 \
  -v clawpanel-data:/root/.openclaw \
  node:22-slim \
  sh -c "apt-get update && apt-get install -y git && \
    npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com && \
    git clone https://github.com/qingchencloud/clawpanel.git /app && \
    cd /app && npm install && npm run build && npm run serve"
```

---

## 访问 ClawPanel

部署完成后，用浏览器打开：

```
http://服务器IP:1420
```

ClawPanel 会自动检测本机的 OpenClaw 安装，你可以：
- 管理模型配置（添加/删除/测试 Provider）
- 启动/停止/重启 Gateway
- 查看 Gateway 日志
- 管理 Agent 记忆文件
- 配置备份与恢复

---

## 进程守护

前台运行会在终端关闭后退出，推荐用 systemd 或 PM2 保持常驻。

### 方式一：systemd（推荐）

创建服务文件：

```bash
# 先确认 node 的实际路径（不同安装方式路径不同）
which node
# 常见路径：/usr/bin/node、/usr/local/bin/node、~/.nvm/versions/node/vXX/bin/node

sudo tee /etc/systemd/system/clawpanel.service << EOF
[Unit]
Description=ClawPanel Web - OpenClaw Management Panel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/clawpanel
ExecStart=$(which node) scripts/serve.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$(dirname $(which node)):$(dirname $(which openclaw 2>/dev/null || echo /usr/local/bin/openclaw))

[Install]
WantedBy=multi-user.target
EOF
```

> ⚠️ **注意**：`ExecStart` 必须使用 Node.js 的**绝对路径**。systemd 不继承用户的 PATH 环境变量，所以 `node` 这种相对路径会找不到。上面的 `$(which node)` 会在创建服务时自动替换为实际路径。`Environment=PATH=...` 确保 OpenClaw CLI 也能被找到。

启用并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable clawpanel
sudo systemctl start clawpanel
```

常用命令：

```bash
sudo systemctl status clawpanel    # 查看状态
sudo systemctl restart clawpanel   # 重启
sudo journalctl -u clawpanel -f    # 查看日志
```

### 方式二：PM2

```bash
npm install -g pm2

cd /opt/clawpanel
npm run build
pm2 start "npm run serve" --name clawpanel
pm2 save
pm2 startup    # 开机自启
```

---

## Nginx 反向代理

如果希望用域名 + HTTPS 访问 ClawPanel：

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

> **重要：** 必须配置 WebSocket 升级（`Upgrade` + `Connection`），否则 ClawPanel 无法连接 Gateway。

配合 Let's Encrypt 启用 HTTPS：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d panel.yourdomain.com
```

---

## 防火墙配置

### UFW (Ubuntu/Debian)

```bash
sudo ufw allow 1420/tcp    # ClawPanel Web
sudo ufw allow 18789/tcp   # OpenClaw Gateway（如需外部直连）
```

### firewalld (CentOS/RHEL)

```bash
sudo firewall-cmd --permanent --add-port=1420/tcp
sudo firewall-cmd --reload
```

---

## 更新升级

### 更新 ClawPanel

```bash
cd /opt/clawpanel        # root 部署路径
# 或 ~/.local/share/clawpanel  # 普通用户路径

git pull origin main
npm install --registry https://registry.npmmirror.com
sudo systemctl restart clawpanel  # 或 pm2 restart clawpanel
```

> 国内拉不到 GitHub？用 Gitee 镜像：
> ```bash
> git remote set-url origin https://gitee.com/QtCodeCreators/clawpanel.git
> git pull origin main
> ```

### 更新 OpenClaw

**方式一：在 ClawPanel 面板中操作**（推荐）

打开「关于」页面 → 点击版本管理，优先切换到当前面板绑定的推荐稳定版。面板会自动处理 sudo 权限、镜像源与 Git HTTPS 兼容。

> **版本策略说明**：ClawPanel 会按面板版本绑定一组 OpenClaw 推荐稳定版，避免老面板直接管理最新版带来的兼容性风险。如需尝试最新版，请在「关于」页手动切换版本，并自行验证兼容性。

**方式二：命令行手动升级**

```bash
# 汉化优化版（示例：ClawPanel 0.9.0 推荐版）
sudo npm install -g @qingchencloud/openclaw-zh@2026.3.7-zh.2 --registry https://registry.npmmirror.com

# 官方原版（示例：ClawPanel 0.9.0 推荐版）
sudo npm install -g openclaw@2026.3.11 --registry https://registry.npmjs.org

# 国内镜像失败时，再切 npm 官方源重试
sudo npm install -g @qingchencloud/openclaw-zh@2026.3.7-zh.2 --registry https://registry.npmjs.org
```

> **维护说明**：如果你是 ClawPanel 维护者，后续只需要更新仓库根目录的 `openclaw-version-policy.json`，即可统一调整不同面板版本对应的推荐 OpenClaw 版本。程序版本号、热更新清单、桌面图标的维护方式见 `docs/version-maintenance.md`。

> **权限说明**：Linux 全局 npm 包安装需要 root 权限。ClawPanel 现已自动检测非 root 用户并加 sudo，同时会自动补 GitHub HTTPS rewrite 规则；如仍遇权限问题，手动加 `sudo` 即可。

### 更新频率

- **ClawPanel**：`git pull` 获取最新代码，无需重新安装依赖（除非 package.json 变了）
- **OpenClaw**：优先通过面板切换到推荐稳定版；如需尝试其它版本，请在「关于」页手动切换
- **前端热更新**：面板支持前端热更新（不需要 git pull），在「关于」页面点击「热更新」按钮即可

---

## 常见问题

### Q: 端口 1420 被占用？

```bash
# 查看占用
lsof -i :1420

# 使用其他端口
npm run serve -- --port 3000
```

systemd 服务也需要改 ExecStart 中的端口。

### Q: 打开面板显示 "openclaw.json 不存在"？

需要先安装 OpenClaw 并初始化：

```bash
npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmmirror.com
openclaw init
```

### Q: Gateway 启动/停止按钮不工作？

ClawPanel Web 版在 Linux 上通过 `child_process` 管理进程。确保：
- `openclaw` 命令在 PATH 中
- 运行 ClawPanel 的用户有权限操作进程

```bash
which openclaw   # 应输出路径
openclaw --version
```

### Q: 从外网无法访问？

1. 检查防火墙是否放行端口 1420
2. 云服务器需在安全组/防火墙规则中开放端口
3. 推荐使用 Nginx 反向代理 + HTTPS，避免直接暴露端口

### Q: 如何同时启动 Gateway 和 ClawPanel？

Gateway 和 ClawPanel 是独立进程，需要分别启动：

```bash
# 启动 Gateway（后台）
openclaw gateway start &

# 启动 ClawPanel Web
cd /opt/clawpanel
npm run serve
```

或者用 systemd 分别创建两个服务。也可以在 ClawPanel 面板中直接点击「启动」按钮管理 Gateway。

### Q: 与桌面版有什么区别？

| 功能 | 桌面版 (Win/Mac) | Web 版 (Linux) |
|------|-----------------|----------------|
| 配置管理 | ✅ | ✅ |
| Gateway 管理 | ✅ | ✅ |
| 模型测试 | ✅ | ✅ |
| 日志查看 | ✅ | ✅ |
| 备份管理 | ✅ | ✅ |
| Agent 记忆 | ✅ | ✅ |
| ZIP 导出 | ✅ | ❌ |
| 系统托盘 | ✅ | ❌ |
| 自动更新 | ✅ | 手动 git pull |
