#!/bin/bash
# ClawPanel Web 版一键部署脚本
# 适用于 WSL / Docker / 远程服务器
# 用法: curl -fsSL https://raw.githubusercontent.com/qingchencloud/clawpanel/main/deploy.sh | bash

set -e

REPO="qingchencloud/clawpanel"
INSTALL_DIR="$HOME/.clawpanel-web"
PORT="${CLAWPANEL_PORT:-9099}"

echo ""
echo "  ClawPanel Web 版 一键部署脚本"
echo "  =============================="
echo ""

# ── 工具函数 ──
fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    echo "❌ 需要 curl 或 wget，请先安装"; exit 1
  fi
}

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  fi
}

# ── 检查依赖 ──
echo "[1/5] 检查依赖..."
command -v node >/dev/null 2>&1 || { echo "❌ 需要 Node.js，请先安装: https://nodejs.org/"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "❌ 需要 npm"; exit 1; }
echo "  node $(node -v) / npm $(npm -v)"

# ── 获取最新版本号 ──
echo "[2/5] 获取最新版本..."
LATEST=$(fetch "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | grep '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/' || echo "")
if [ -z "$LATEST" ]; then
  echo "  无法获取最新版本，使用 main 分支"
  DOWNLOAD_URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"
else
  echo "  最新版本: v$LATEST"
  DOWNLOAD_URL="https://github.com/$REPO/archive/refs/tags/v$LATEST.tar.gz"
fi

# ── 下载并解压 ──
echo "[3/5] 下载源码..."
TMP_FILE=$(mktemp /tmp/clawpanel-XXXXXX.tar.gz)
trap "rm -f $TMP_FILE" EXIT
download "$DOWNLOAD_URL" "$TMP_FILE"
if [ ! -s "$TMP_FILE" ]; then
  echo "❌ 下载失败，请检查网络连接"; exit 1
fi
mkdir -p "$INSTALL_DIR"
tar xzf "$TMP_FILE" -C "$INSTALL_DIR" --strip-components=1
echo "  解压到 $INSTALL_DIR"

# ── 安装依赖并构建 ──
echo "[4/5] 安装依赖..."
cd "$INSTALL_DIR"
npm install 2>&1 | tail -1

echo "[5/5] 构建前端..."
npx vite build --mode development 2>&1 | tail -2

echo ""
echo "  ==============================="
echo "  ClawPanel Web 版部署完成！"
echo "  ==============================="
echo ""
echo "  启动:  cd $INSTALL_DIR && npx serve dist -l $PORT"
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
echo "  访问:  http://$IP:$PORT"
echo ""
echo "  提示: 需要本地 OpenClaw Gateway 运行中（默认端口 3456）"
echo "        安装: npm i -g @qingchencloud/openclaw-zh"
echo "        启动: openclaw start"
echo ""
