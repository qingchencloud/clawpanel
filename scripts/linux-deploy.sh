#!/bin/bash
set -e

echo "=========================================="
echo "  ClawPanel Web 版 一键部署脚本"
echo "  在 Linux 上通过浏览器管理 OpenClaw"
echo "=========================================="
echo ""

PANEL_PORT=1420
REPO_URL="https://github.com/qingchencloud/clawpanel.git"
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
    echo "🖥️  系统: $OS $(uname -m)"
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

# 安装 OpenClaw
install_openclaw() {
    if command -v openclaw &> /dev/null; then
        echo "✅ OpenClaw 已安装: $(openclaw --version 2>/dev/null || echo '未知版本')"
    else
        echo "📦 安装 OpenClaw 汉化版..."
        npm install -g @qingchencloud/openclaw-zh --registry "$NPM_REGISTRY"
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
        npm install
    else
        echo "📦 克隆 ClawPanel..."
        mkdir -p "$INSTALL_DIR"
        git clone "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
        npm install
    fi
    # 生产构建（生成优化后的静态文件）
    echo "📦 构建生产版本..."
    cd "$INSTALL_DIR"
    npx vite build
    echo "✅ ClawPanel 安装完成: $INSTALL_DIR"
}

# 创建 systemd 服务
setup_systemd() {
    if ! command -v systemctl &> /dev/null; then
        echo "⚠️  systemd 不可用，请手动启动："
        echo "   cd $INSTALL_DIR && npx vite --port $PANEL_PORT --host 0.0.0.0"
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
ExecStart=$(which npx) vite preview --port $PANEL_PORT --host 0.0.0.0
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
ExecStart=$(which npx) vite preview --port $PANEL_PORT --host 0.0.0.0
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
