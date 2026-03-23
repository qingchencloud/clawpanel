#!/bin/bash
set -e

echo "=========================================="
echo "  ClawPanel Web 版 一键部署脚本"
echo "  在 Linux 上通过浏览器管理 OpenClaw"
echo "=========================================="
echo ""

PANEL_PORT=1420
REPO_URL="https://github.com/qingchencloud/clawpanel.git"
REPO_URL_GITEE="https://gitee.com/QtCodeCreators/clawpanel.git"
NPM_REGISTRY="https://registry.npmmirror.com"

# 检测权限模式
if [ "$(id -u)" = "0" ]; then
    IS_ROOT=true
    INSTALL_DIR="/opt/clawpanel"
    SYSTEMD_DIR="/etc/systemd/system"
    echo "🔑 以 root 身份运行，安装到 $INSTALL_DIR"
else
    IS_ROOT=false
    INSTALL_DIR="$HOME/.local/share/clawpanel"
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    echo "👤 以普通用户身份运行，安装到 $INSTALL_DIR"
fi

# 带权限执行（安装系统包时需要）
run_pkg_cmd() {
    if [ "$IS_ROOT" = true ]; then
        "$@"
    else
        sudo "$@"
    fi
}

# 检测系统
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
        OS_LIKE=$ID_LIKE
    elif [ -f /etc/redhat-release ]; then
        OS="centos"
    else
        OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    fi
    ARCH=$(uname -m)
    echo "🖥️  系统: $OS $ARCH"

    # ARM 架构检测和提示
    case "$ARCH" in
        aarch64|arm64)
            echo "✅ ARM64 架构，Web 模式和 Docker 模式均支持"
            ;;
        armv7*|armhf)
            echo "⚠️  ARM 32位 ($ARCH)：Web 模式可用，Docker 镜像仅支持 arm64"
            ;;
        armv6*)
            echo "⚠️  ARM v6 ($ARCH)：内存和性能可能不足，建议升级到 ARM64 设备"
            ;;
        x86_64|amd64)
            ;;
        *)
            echo "ℹ️  架构: $ARCH"
            ;;
    esac
}

# 安装 Node.js
install_node() {
    if command -v node &> /dev/null; then
        local node_major=$(node -v | sed 's/v//' | cut -d. -f1)
        if [ "$node_major" -ge 18 ]; then
            echo "✅ Node.js $(node -v) 已安装"
            return 0
        else
            echo "⚠️  Node.js $(node -v) 版本过低，需要 18+"
        fi
    fi

    echo "📦 安装 Node.js 22 LTS..."
    case "$OS" in
        ubuntu|debian|linuxmint|pop)
            curl -fsSL https://deb.nodesource.com/setup_22.x | run_pkg_cmd bash -
            run_pkg_cmd apt-get install -y nodejs
            ;;
        centos|rhel|fedora|rocky|alma)
            curl -fsSL https://rpm.nodesource.com/setup_22.x | run_pkg_cmd bash -
            run_pkg_cmd yum install -y nodejs
            ;;
        alpine)
            run_pkg_cmd apk add nodejs npm git
            ;;
        arch|manjaro)
            run_pkg_cmd pacman -Sy --noconfirm nodejs npm git
            ;;
        *)
            echo "❌ 不支持自动安装 Node.js，请手动安装后重试"
            echo "   参考: https://nodejs.org/en/download/"
            exit 1
            ;;
    esac
    echo "✅ Node.js $(node -v) 安装完成"
}

# 安装 Git
install_git() {
    if command -v git &> /dev/null; then
        echo "✅ Git 已安装"
        return 0
    fi

    echo "📦 安装 Git..."
    case "$OS" in
        ubuntu|debian|linuxmint|pop)
            run_pkg_cmd apt-get update && run_pkg_cmd apt-get install -y git
            ;;
        centos|rhel|fedora|rocky|alma)
            run_pkg_cmd yum install -y git
            ;;
        alpine)
            run_pkg_cmd apk add git
            ;;
        arch|manjaro)
            run_pkg_cmd pacman -Sy --noconfirm git
            ;;
    esac
    echo "✅ Git 安装完成"
}

# 查找 openclaw 可执行文件（兼容各种安装方式）
find_openclaw() {
    # 1. 直接在 PATH 中查找
    if command -v openclaw &> /dev/null; then
        echo "$(command -v openclaw)"
        return 0
    fi
    # 2. 常见 npm 全局安装路径
    local candidates=(
        "/usr/local/bin/openclaw"
        "/usr/bin/openclaw"
        "$HOME/.npm-global/bin/openclaw"
        "$HOME/.local/bin/openclaw"
    )
    # 3. 从 npm prefix 获取（不使用 sudo，避免触发密码提示）
    local npm_prefix=$(npm config get prefix 2>/dev/null)
    if [ -n "$npm_prefix" ]; then
        candidates+=("$npm_prefix/bin/openclaw")
    fi
    for p in "${candidates[@]}"; do
        if [ -x "$p" ]; then
            echo "$p"
            return 0
        fi
    done
    return 1
}

# 检测 OpenClaw 版本来源（官方 vs 汉化版）
detect_openclaw_source() {
    local oc_bin="$1"
    local ver=$("$oc_bin" --version 2>/dev/null || echo "")
    if echo "$ver" | grep -qi "zh\|汉化\|chinese"; then
        echo "chinese"
    else
        echo "official"
    fi
}

# 安装 OpenClaw
install_openclaw() {
    local oc_path=$(find_openclaw)
    if [ -n "$oc_path" ]; then
        local oc_ver=$("$oc_path" --version 2>/dev/null || echo "未知版本")
        local oc_src=$(detect_openclaw_source "$oc_path")
        if [ "$oc_src" = "chinese" ]; then
            echo "✅ OpenClaw 汉化版已安装: $oc_ver (${oc_path})"
        else
            echo "✅ OpenClaw 已安装: $oc_ver (${oc_path})"
        fi
        # 确保 openclaw 在 PATH 中（防止后续步骤找不到）
        if ! command -v openclaw &> /dev/null; then
            export PATH="$(dirname "$oc_path"):$PATH"
            echo "ℹ️  已将 $(dirname "$oc_path") 加入 PATH"
        fi
    else
        echo "📦 安装 OpenClaw 汉化版..."
        if [ "$IS_ROOT" = true ]; then
            npm install -g @qingchencloud/openclaw-zh --registry "$NPM_REGISTRY" || \
            npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmjs.org
        else
            sudo -E npm install -g @qingchencloud/openclaw-zh --registry "$NPM_REGISTRY" || \
            sudo -E npm install -g @qingchencloud/openclaw-zh --registry https://registry.npmjs.org
        fi
        echo "✅ OpenClaw 安装完成"
    fi

    # 初始化配置（如果不存在）
    if [ ! -f "$HOME/.openclaw/openclaw.json" ]; then
        echo "🔧 初始化 OpenClaw 配置..."
        openclaw init 2>/dev/null || true
    fi
}

# 克隆并安装 ClawPanel
install_clawpanel() {
    if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/package.json" ]; then
        echo "📦 ClawPanel 已存在，更新中..."
        cd "$INSTALL_DIR"
        git pull origin main 2>/dev/null || true
        npm install --registry "$NPM_REGISTRY"
    else
        echo "📦 克隆 ClawPanel..."
        mkdir -p "$INSTALL_DIR"
        if ! git clone "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
            echo "⚠️  GitHub 克隆失败，切换到 Gitee 国内镜像..."
            git clone "$REPO_URL_GITEE" "$INSTALL_DIR"
        fi
        cd "$INSTALL_DIR"
        npm install --registry "$NPM_REGISTRY"
    fi
    # 生产构建（生成优化后的静态文件）
    echo "📦 构建生产版本..."
    cd "$INSTALL_DIR"
    npx vite build
    echo "✅ ClawPanel 安装完成: $INSTALL_DIR"
    echo "✅ 启动命令: npm run serve"
}

# 创建 systemd 服务
setup_systemd() {
    if ! command -v systemctl &> /dev/null; then
        echo "⚠️  systemd 不可用，请手动启动："
        echo "   cd $INSTALL_DIR && npm run serve -- --port $PANEL_PORT"
        return 0
    fi

    echo "🔧 创建 systemd 服务..."
    mkdir -p "$SYSTEMD_DIR"

    if [ "$IS_ROOT" = true ]; then
        cat > "$SYSTEMD_DIR/clawpanel.service" << EOF
[Unit]
Description=ClawPanel Web - OpenClaw Management Panel
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) scripts/serve.js --port $PANEL_PORT
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=HOME=$HOME

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable clawpanel
        systemctl start clawpanel
    else
        cat > "$SYSTEMD_DIR/clawpanel.service" << EOF
[Unit]
Description=ClawPanel Web - OpenClaw Management Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) scripts/serve.js --port $PANEL_PORT
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=HOME=$HOME

[Install]
WantedBy=default.target
EOF
        systemctl --user daemon-reload
        systemctl --user enable clawpanel
        systemctl --user start clawpanel
        # 允许用户服务在未登录时继续运行
        loginctl enable-linger "$(whoami)" 2>/dev/null || true
    fi
    echo "✅ systemd 服务已创建并启动"
}

# 获取本机 IP
get_local_ip() {
    ip route get 1 2>/dev/null | awk '{print $7; exit}' || \
    hostname -I 2>/dev/null | awk '{print $1}' || \
    echo "localhost"
}

# 生成默认访问密码
setup_default_password() {
    local config_dir="$HOME/.openclaw"
    local config_file="$config_dir/clawpanel.json"
    mkdir -p "$config_dir"

    # 已存在配置且有密码则跳过
    if [ -f "$config_file" ]; then
        local existing_pw=$(grep -o '"accessPassword"[[:space:]]*:[[:space:]]*"[^"]*"' "$config_file" | head -1)
        if [ -n "$existing_pw" ]; then
            echo "ℹ️  已有访问密码，跳过生成"
            DEFAULT_PASSWORD=""
            return
        fi
    fi

    DEFAULT_PASSWORD="123456"
    cat > "$config_file" <<EOF
{
  "accessPassword": "123456",
  "mustChangePassword": true
}
EOF
    echo "✅ 已设置默认访问密码: 123456"
}

# 主流程
main() {
    detect_os
    echo ""
    install_git
    install_node
    install_openclaw
    install_clawpanel
    setup_default_password
    setup_systemd

    local ip=$(get_local_ip)

    if [ "$IS_ROOT" = true ]; then
        local ctl_cmd="systemctl"
    else
        local ctl_cmd="systemctl --user"
    fi

    echo ""
    echo "=========================================="
    echo "  ✅ ClawPanel Web 版部署完成！"
    echo "=========================================="
    echo ""
    echo "  🌐 访问地址: http://${ip}:${PANEL_PORT}"
    echo "  📁 安装目录: $INSTALL_DIR"
    echo "  📋 配置目录: $HOME/.openclaw/"
    if [ -n "$DEFAULT_PASSWORD" ]; then
        echo ""
        echo "  🔑 默认访问密码: $DEFAULT_PASSWORD"
        echo "  ⚠️  首次登录后会要求修改密码，请妥善保管新密码！"
    fi
    echo ""
    echo "  常用命令："
    echo "    $ctl_cmd status clawpanel    # 查看状态"
    echo "    $ctl_cmd restart clawpanel   # 重启面板"
    if [ "$IS_ROOT" = true ]; then
        echo "    journalctl -u clawpanel -f    # 查看日志"
    else
        echo "    journalctl --user -u clawpanel -f    # 查看日志"
    fi
    echo ""
    echo "  用浏览器打开上面的地址，即可管理 OpenClaw。"
    echo "=========================================="
}

main "$@"
