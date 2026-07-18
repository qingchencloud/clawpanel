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
DEPLOY_SCRIPT_URL="https://raw.githubusercontent.com/qingchencloud/clawpanel/main/scripts/linux-deploy.sh"
NPM_REGISTRY="https://registry.npmmirror.com"
PANEL_NODE_MIN_VERSION="18.0.0"
OPENCLAW_RECOMMENDED_VERSION="2026.7.1-zh.2"
OPENCLAW_NODE_22_19_FLOOR_VERSION="2026.6.5"
OPENCLAW_NODE_7_1_FLOOR_VERSION="2026.7.1"
OPENCLAW_NODE_22_19_REQUIREMENT=">=22.19.0"
OPENCLAW_7_1_NODE_REQUIREMENT=">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0"
NODE_MIN_VERSION="$PANEL_NODE_MIN_VERSION"
NODE_REQUIREMENT=">=${PANEL_NODE_MIN_VERSION}"

# 检测权限模式
if [ "$(id -u)" = "0" ]; then
    IS_ROOT=true
    INSTALL_DIR="/opt/clawpanel"
    SYSTEMD_DIR="/etc/systemd/system"
    SERVICE_SCOPE="system"
else
    IS_ROOT=false
    INSTALL_DIR="$HOME/.local/share/clawpanel"
    SYSTEMD_DIR="$HOME/.config/systemd/user"
    SERVICE_SCOPE="user"
fi

# 优先沿用已有 systemd 服务的工作目录，避免用不同权限重复安装两套面板
select_install_context() {
    local system_install_dir=""
    local user_install_dir=""

    if command -v systemctl &> /dev/null; then
        system_install_dir=$(systemctl show clawpanel --property=WorkingDirectory --value 2>/dev/null || true)
        if [ "$IS_ROOT" = false ]; then
            user_install_dir=$(systemctl --user show clawpanel --property=WorkingDirectory --value 2>/dev/null || true)
        fi
    fi

    if [ -z "$system_install_dir" ] && [ -f "/etc/systemd/system/clawpanel.service" ]; then
        system_install_dir=$(sed -n 's/^WorkingDirectory=//p' /etc/systemd/system/clawpanel.service | head -1)
    fi
    if [ "$IS_ROOT" = false ] && [ -z "$user_install_dir" ] && [ -f "$HOME/.config/systemd/user/clawpanel.service" ]; then
        user_install_dir=$(sed -n 's/^WorkingDirectory=//p' "$HOME/.config/systemd/user/clawpanel.service" | head -1)
    fi

    if [ "$IS_ROOT" = false ] && [ -n "$user_install_dir" ] && [ -f "$user_install_dir/package.json" ]; then
        INSTALL_DIR="$user_install_dir"
        SYSTEMD_DIR="$HOME/.config/systemd/user"
        SERVICE_SCOPE="user"
    elif [ -n "$system_install_dir" ] && [ -f "$system_install_dir/package.json" ]; then
        if [ "$IS_ROOT" = false ]; then
            echo "❌ 检测到系统级 ClawPanel 安装: $system_install_dir"
            echo "   请使用 root 权限升级，避免在用户目录重复安装："
            echo "   curl -fsSL $DEPLOY_SCRIPT_URL | sudo bash"
            exit 1
        fi
        INSTALL_DIR="$system_install_dir"
        SYSTEMD_DIR="/etc/systemd/system"
        SERVICE_SCOPE="system"
    elif [ "$IS_ROOT" = false ] && [ -f "/opt/clawpanel/package.json" ]; then
        echo "❌ 检测到系统级 ClawPanel 安装: /opt/clawpanel"
        echo "   请使用 root 权限升级，避免在用户目录重复安装："
        echo "   curl -fsSL $DEPLOY_SCRIPT_URL | sudo bash"
        exit 1
    fi

    if [ "$SERVICE_SCOPE" = "system" ]; then
        echo "🔑 使用系统级安装目录: $INSTALL_DIR"
    else
        echo "👤 使用用户级安装目录: $INSTALL_DIR"
    fi
}

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

# 比较语义版本，要求 actual >= min
version_ge() {
    local actual="${1#v}"
    local min="${2#v}"
    local actual_major actual_minor actual_patch min_major min_minor min_patch
    actual=$(printf '%s' "$actual" | grep -Eo '[0-9]+(\.[0-9]+){0,2}' | head -1 || true)
    min=$(printf '%s' "$min" | grep -Eo '[0-9]+(\.[0-9]+){0,2}' | head -1 || true)
    if [ -z "$actual" ] || [ -z "$min" ]; then return 1; fi
    IFS=. read -r actual_major actual_minor actual_patch <<< "$actual"
    IFS=. read -r min_major min_minor min_patch <<< "$min"
    actual_major=${actual_major:-0}
    actual_minor=${actual_minor:-0}
    actual_patch=${actual_patch:-0}
    min_major=${min_major:-0}
    min_minor=${min_minor:-0}
    min_patch=${min_patch:-0}
    if [ "$actual_major" -gt "$min_major" ]; then return 0; fi
    if [ "$actual_major" -lt "$min_major" ]; then return 1; fi
    if [ "$actual_minor" -gt "$min_minor" ]; then return 0; fi
    if [ "$actual_minor" -lt "$min_minor" ]; then return 1; fi
    [ "$actual_patch" -ge "$min_patch" ]
}

node_version_satisfies_7_1() {
    local actual="${1#v}"
    local major
    actual=$(printf '%s' "$actual" | grep -Eo '[0-9]+(\.[0-9]+){0,2}' | head -1 || true)
    major=${actual%%.*}
    case "$major" in
        22) version_ge "$actual" "22.22.3" && ! version_ge "$actual" "23.0.0" ;;
        24) version_ge "$actual" "24.15.0" && ! version_ge "$actual" "25.0.0" ;;
        *) [ "$major" -ge 25 ] 2>/dev/null && version_ge "$actual" "25.9.0" ;;
    esac
}

node_version_satisfies_requirement() {
    if [ "$NODE_REQUIREMENT" = "$OPENCLAW_7_1_NODE_REQUIREMENT" ]; then
        node_version_satisfies_7_1 "$1"
    else
        version_ge "$1" "$NODE_MIN_VERSION"
    fi
}

# 安装 Node.js
install_node() {
    if command -v node &> /dev/null; then
        local node_version
        node_version=$(node -v)
        if node_version_satisfies_requirement "$node_version"; then
            echo "✅ Node.js $(node -v) 已安装"
            return 0
        else
            echo "⚠️  Node.js $(node -v) 不满足要求 ${NODE_REQUIREMENT}"
        fi
    fi

    echo "📦 安装 Node.js LTS（要求 ${NODE_REQUIREMENT}）..."
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
    if ! node_version_satisfies_requirement "$(node -v)"; then
        echo "❌ Node.js $(node -v) 仍不满足 OpenClaw 要求 ${NODE_REQUIREMENT}"
        echo "   请手动安装满足 ${NODE_REQUIREMENT} 的 Node.js 后重试"
        exit 1
    fi
    echo "✅ Node.js $(node -v) 安装完成"
}

ensure_node_for_openclaw_version() {
    local openclaw_version="$1"
    local base_version="${openclaw_version%%-*}"
    if [ -n "$base_version" ] && version_ge "$base_version" "$OPENCLAW_NODE_7_1_FLOOR_VERSION"; then
        NODE_MIN_VERSION="22.22.3"
        NODE_REQUIREMENT="$OPENCLAW_7_1_NODE_REQUIREMENT"
        echo "ℹ️  OpenClaw ${openclaw_version} 需要 Node.js ${NODE_REQUIREMENT}"
        install_node
    elif [ -n "$base_version" ] && version_ge "$base_version" "$OPENCLAW_NODE_22_19_FLOOR_VERSION"; then
        NODE_MIN_VERSION="22.19.0"
        NODE_REQUIREMENT="$OPENCLAW_NODE_22_19_REQUIREMENT"
        echo "ℹ️  OpenClaw ${openclaw_version} 需要 Node.js ${NODE_REQUIREMENT}"
        install_node
    fi
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
    ensure_node_for_openclaw_version "$OPENCLAW_RECOMMENDED_VERSION"
    local oc_path=$(find_openclaw)
    local oc_ver=""
    if [ -n "$oc_path" ]; then
        oc_ver=$("$oc_path" --version 2>/dev/null || echo "未知版本")
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
        echo "📦 安装 OpenClaw 汉化版稳定版 ${OPENCLAW_RECOMMENDED_VERSION}..."
        local openclaw_spec="@qingchencloud/openclaw-zh@${OPENCLAW_RECOMMENDED_VERSION}"
        if [ "$IS_ROOT" = true ]; then
            npm install -g "$openclaw_spec" --registry "$NPM_REGISTRY" || \
            npm install -g "$openclaw_spec" --registry https://registry.npmjs.org
        else
            sudo -E npm install -g "$openclaw_spec" --registry "$NPM_REGISTRY" || \
            sudo -E npm install -g "$openclaw_spec" --registry https://registry.npmjs.org
        fi
        echo "✅ OpenClaw 安装完成"
        oc_path=$(find_openclaw)
        if [ -n "$oc_path" ]; then
            oc_ver=$("$oc_path" --version 2>/dev/null || echo "$OPENCLAW_RECOMMENDED_VERSION")
        else
            oc_ver="$OPENCLAW_RECOMMENDED_VERSION"
        fi
    fi

    ensure_node_for_openclaw_version "$oc_ver"

    # 初始化配置（如果不存在）
    if [ ! -f "$HOME/.openclaw/openclaw.json" ]; then
        echo "🔧 初始化 OpenClaw 配置..."
        openclaw init 2>/dev/null || true
    fi
}

# 修复 npm 缓存权限（曾用 sudo npm install 导致缓存被 root 拥有）
fix_npm_cache_permissions() {
    local npm_cache_dir="$HOME/.npm"
    if [ -d "$npm_cache_dir" ]; then
        # 检查是否存在 root 拥有的文件
        local root_files=$(find "$npm_cache_dir" -uid 0 2>/dev/null | head -1)
        if [ -n "$root_files" ]; then
            echo "⚠️  检测到 npm 缓存中存在 root 权限文件，正在修复..."
            if [ "$IS_ROOT" = true ]; then
                chown -R "$(stat -c '%u:%g' "$HOME")" "$npm_cache_dir" 2>/dev/null || true
            else
                sudo chown -R "$(id -u):$(id -g)" "$npm_cache_dir" 2>/dev/null || true
            fi
            echo "✅ npm 缓存权限已修复"
        fi
    fi
}

# 克隆并安装 ClawPanel
install_clawpanel() {
    # 预检 npm 缓存权限（#236: 全新系统部署时 npm cache 可能被 root 污染）
    fix_npm_cache_permissions

    if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/package.json" ]; then
        echo "📦 ClawPanel 已存在，更新中..."
        cd "$INSTALL_DIR"
        if [ ! -d ".git" ]; then
            echo "❌ ClawPanel 源码更新失败：$INSTALL_DIR 不是 Git 仓库"
            echo "   请保留 ~/.openclaw 数据后重新执行安装脚本"
            exit 1
        fi
        if ! git diff --quiet || ! git diff --cached --quiet; then
            echo "❌ ClawPanel 源码更新失败：检测到未提交的本地修改"
            echo "   请先执行 git status 并处理这些修改，脚本不会自动覆盖"
            git status --short
            exit 1
        fi
        if ! git pull --ff-only origin main; then
            echo "❌ ClawPanel 源码更新失败，请检查上方 Git 错误、网络和远程仓库地址"
            echo "   当前远程: $(git remote get-url origin 2>/dev/null || echo '未知')"
            exit 1
        fi
        # 清理可能损坏的 node_modules（上次 npm install 失败残留）
        if [ -d "node_modules" ] && [ ! -f "node_modules/.package-lock.json" ]; then
            echo "⚠️  检测到不完整的 node_modules，清理后重新安装..."
            rm -rf node_modules
        fi
        npm install --registry "$NPM_REGISTRY" || {
            echo "⚠️  npm install 失败，清理 node_modules 后重试..."
            rm -rf node_modules
            npm install --registry "$NPM_REGISTRY"
        }
    else
        echo "📦 克隆 ClawPanel..."
        mkdir -p "$INSTALL_DIR"
        if ! git clone "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
            echo "⚠️  GitHub 克隆失败，切换到 Gitee 国内镜像..."
            git clone "$REPO_URL_GITEE" "$INSTALL_DIR"
        fi
        cd "$INSTALL_DIR"
        npm install --registry "$NPM_REGISTRY" || {
            echo "⚠️  npm install 失败，清理 node_modules 后重试..."
            rm -rf node_modules
            npm install --registry "$NPM_REGISTRY"
        }
    fi
    # 生产构建（生成优化后的静态文件）
    echo "📦 构建生产版本..."
    cd "$INSTALL_DIR"
    npx vite build
    PANEL_VERSION=$(node -p "require('./package.json').version")
    echo "✅ ClawPanel 安装完成: $INSTALL_DIR"
    echo "✅ ClawPanel 版本: $PANEL_VERSION"
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

    if [ "$SERVICE_SCOPE" = "system" ]; then
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
Environment=PATH=$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.volta/bin:$(dirname $(which node)):$PATH

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable clawpanel
        systemctl restart clawpanel
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
Environment=PATH=$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.volta/bin:$(dirname $(which node)):$PATH

[Install]
WantedBy=default.target
EOF
        systemctl --user daemon-reload
        systemctl --user enable clawpanel
        systemctl --user restart clawpanel
        # 允许用户服务在未登录时继续运行
        loginctl enable-linger "$(whoami)" 2>/dev/null || true
    fi
    echo "✅ systemd 服务已更新并重启"
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
    select_install_context
    detect_os
    echo ""
    install_git
    install_node
    install_openclaw
    install_clawpanel
    setup_default_password
    setup_systemd

    local ip=$(get_local_ip)

    if [ "$SERVICE_SCOPE" = "system" ]; then
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
    if [ "$SERVICE_SCOPE" = "system" ]; then
        echo "    journalctl -u clawpanel -f    # 查看日志"
    else
        echo "    journalctl --user -u clawpanel -f    # 查看日志"
    fi
    echo ""
    echo "  用浏览器打开上面的地址，即可管理 OpenClaw。"
    echo "=========================================="
}

main "$@"
