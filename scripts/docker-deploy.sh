#!/bin/bash
# =============================================================================
# ClawPanel Docker 部署脚本
# =============================================================================
# 功能:
#   1. 检查 Docker 环境
#   2. 构建 Docker 镜像
#   3. 启动/停止/重启容器
#   4. 查看日志
#   5. 常见问题排查
# =============================================================================

set -e

# -----------------------------------------------------------------------------
# 颜色定义
# -----------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# -----------------------------------------------------------------------------
# 配置
# -----------------------------------------------------------------------------
CONTAINER_NAME="clawpanel"
IMAGE_NAME="clawpanel"
IMAGE_TAG="latest"
DEFAULT_PORT=1420
CONFIG_DIR="$HOME/.openclaw"
DATA_DIR="$(pwd)/data"

# -----------------------------------------------------------------------------
# 工具函数
# -----------------------------------------------------------------------------
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${CYAN}[STEP]${NC} $1"
}

separator() {
    echo "--------------------------------------------------------------------------------"
}

# -----------------------------------------------------------------------------
# 检查 Docker 环境
# -----------------------------------------------------------------------------
check_docker() {
    log_step "检查 Docker 环境..."
    
    # 检查 Docker 是否安装
    if ! command -v docker &> /dev/null; then
        log_error "Docker 未安装或不在 PATH 中"
        echo ""
        echo "请先安装 Docker:"
        echo "  Ubuntu/Debian:  curl -fsSL https://get.docker.com | sh"
        echo "  CentOS/RHEL:   yum install -y docker-ce"
        echo "  Arch Linux:     pacman -S docker"
        exit 1
    fi
    
    # 检查 Docker 服务是否运行
    if ! docker info &> /dev/null; then
        log_error "Docker 服务未运行"
        echo ""
        echo "请启动 Docker 服务:"
        echo "  sudo systemctl start docker"
        exit 1
    fi
    
    # 检查 Docker Compose
    if docker compose version &> /dev/null; then
        COMPOSE_CMD="docker compose"
        log_info "Docker Compose v2 可用"
    elif command -v docker-compose &> /dev/null; then
        COMPOSE_CMD="docker-compose"
        log_info "Docker Compose v1 可用"
    else
        log_warn "Docker Compose 未安装，部分功能可能不可用"
        COMPOSE_CMD=""
    fi
    
    log_info "Docker 环境检查通过"
}

# -----------------------------------------------------------------------------
# 检查前置要求
# -----------------------------------------------------------------------------
check_requirements() {
    log_step "检查前置要求..."
    
    # 检查构建上下文
    if [ ! -f "Dockerfile" ]; then
        log_error "Dockerfile 不存在，请确保在项目根目录运行此脚本"
        exit 1
    fi
    
    if [ ! -f "package.json" ]; then
        log_error "package.json 不存在，请确保在项目根目录运行此脚本"
        exit 1
    fi
    
    # 创建必要目录
    mkdir -p "$DATA_DIR"
    
    log_info "前置要求检查通过"
}

# -----------------------------------------------------------------------------
# 拉取最新代码（可选）
# -----------------------------------------------------------------------------
pull_latest() {
    log_step "检查更新..."
    
    if [ -d ".git" ]; then
        git fetch origin main
        LOCAL=$(git rev-parse @)
        REMOTE=$(git rev-parse origin/main)
        
        if [ "$LOCAL" != "$REMOTE" ]; then
            log_warn "本地版本落后于远程，是否更新？"
            read -p "输入 y 更新，其他跳过: " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                log_info "更新代码..."
                git pull origin main
            fi
        else
            log_info "已是最新版本"
        fi
    fi
}

# -----------------------------------------------------------------------------
# 构建镜像
# -----------------------------------------------------------------------------
build_image() {
    log_step "构建 Docker 镜像..."
    
    # 启用 BuildKit
    export DOCKER_BUILDKIT=1
    
    # 构建镜像
    log_info "构建镜像: ${IMAGE_NAME}:${IMAGE_TAG}"
    
    if docker build \
        --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
        --tag "${IMAGE_NAME}:latest" \
        --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
        --progress=plain \
        .; then
        log_info "镜像构建成功"
    else
        log_error "镜像构建失败"
        exit 1
    fi
    
    # 显示镜像大小
    IMAGE_SIZE=$(docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "{{.Size}}")
    log_info "镜像大小: $IMAGE_SIZE"
}

# -----------------------------------------------------------------------------
# 启动容器
# -----------------------------------------------------------------------------
start_container() {
    log_step "启动容器..."
    
    # 检查容器是否已存在
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
            log_warn "容器已在运行中"
            return 0
        else
            log_info "容器已存在，重新启动..."
            docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1
        fi
    fi
    
    # 检查配置目录
    if [ ! -d "$CONFIG_DIR" ]; then
        log_warn "OpenClaw 配置目录不存在: $CONFIG_DIR"
        log_info "将创建目录..."
        mkdir -p "$CONFIG_DIR"
    fi
    
    # 启动容器（使用 host 网络模式）
    log_info "启动容器 (host 网络模式)..."
    
    docker run -d \
        --name "$CONTAINER_NAME" \
        --hostname "$CONTAINER_NAME" \
        --network host \
        --restart unless-stopped \
        --volume "$CONFIG_DIR:/root/.openclaw" \
        --volume "$DATA_DIR:/app/data" \
        --env "NODE_ENV=production" \
        --env "OPENCLAW_URL=http://127.0.0.1:18789" \
        --env "TZ=Asia/Shanghai" \
        --health-cmd "curl -f http://localhost:1420/ || exit 1" \
        --health-interval "30s" \
        --health-timeout "5s" \
        --health-retries "3" \
        --log-driver "json-file" \
        --log-opt "max-size=10m" \
        --log-opt "max-file=3" \
        "${IMAGE_NAME}:${IMAGE_TAG}"
    
    if [ $? -eq 0 ]; then
        log_info "容器启动成功"
    else
        log_error "容器启动失败"
        exit 1
    fi
}

# -----------------------------------------------------------------------------
# 停止容器
# -----------------------------------------------------------------------------
stop_container() {
    log_step "停止容器..."
    
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        docker stop "$CONTAINER_NAME"
        log_info "容器已停止"
    else
        log_warn "容器未运行"
    fi
}

# -----------------------------------------------------------------------------
# 重启容器
# -----------------------------------------------------------------------------
restart_container() {
    log_step "重启容器..."
    stop_container
    sleep 2
    start_container
}

# -----------------------------------------------------------------------------
# 删除容器
# -----------------------------------------------------------------------------
remove_container() {
    log_step "删除容器..."
    
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1
        log_info "容器已删除"
    else
        log_warn "容器不存在"
    fi
}

# -----------------------------------------------------------------------------
# 查看状态
# -----------------------------------------------------------------------------
show_status() {
    log_step "容器状态:"
    
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo ""
        docker ps -a --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
        
        # 显示资源使用
        echo ""
        log_info "资源使用:"
        docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" "$CONTAINER_NAME" 2>/dev/null || true
    else
        log_warn "容器不存在"
    fi
}

# -----------------------------------------------------------------------------
# 查看日志
# -----------------------------------------------------------------------------
show_logs() {
    log_step "容器日志 (Ctrl+C 退出):"
    echo ""
    
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        docker logs -f "$CONTAINER_NAME"
    else
        log_error "容器未运行，无法查看日志"
        exit 1
    fi
}

# -----------------------------------------------------------------------------
# 进入容器
# -----------------------------------------------------------------------------
enter_container() {
    log_step "进入容器 shell..."
    echo ""
    
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        docker exec -it "$CONTAINER_NAME" /bin/sh
    else
        log_error "容器未运行，无法进入"
        exit 1
    fi
}

# -----------------------------------------------------------------------------
# 常见问题排查
# -----------------------------------------------------------------------------
troubleshoot() {
    echo ""
    separator
    log_info "常见问题排查"
    separator
    echo ""
    
    log_info "1. 检查容器是否运行:"
    echo "   docker ps | grep $CONTAINER_NAME"
    echo ""
    
    log_info "2. 查看容器日志:"
    echo "   docker logs $CONTAINER_NAME"
    echo ""
    
    log_info "3. 检查端口占用:"
    echo "   netstat -tlnp | grep 1420"
    echo "   ss -tlnp | grep 1420"
    echo ""
    
    log_info "4. 检查 OpenClaw 配置:"
    echo "   cat ~/.openclaw/openclaw.json"
    echo ""
    
    log_info "5. 测试 Gateway 连接:"
    echo "   curl http://localhost:18789/health"
    echo ""
    
    log_info "6. 重建容器:"
    echo "   ./docker-deploy.sh rebuild"
    echo ""
    
    log_info "7. 完全重置:"
    echo "   docker stop $CONTAINER_NAME && docker rm $CONTAINER_NAME"
    echo "   docker rmi ${IMAGE_NAME}:${IMAGE_TAG}"
    echo "   ./docker-deploy.sh start"
    echo ""
    
    log_info "8. 查看 OpenClaw 日志:"
    echo "   docker exec $CONTAINER_NAME cat /home/appuser/.openclaw/logs/gateway.log"
    echo ""
    
    separator
    echo ""
}

# -----------------------------------------------------------------------------
# 获取本机 IP
# -----------------------------------------------------------------------------
get_local_ip() {
    ip route get 1 2>/dev/null | awk '{print $7; exit}' || \
    hostname -I 2>/dev/null | awk '{print $1}' || \
    echo "localhost"
}

# -----------------------------------------------------------------------------
# 显示访问信息
# -----------------------------------------------------------------------------
show_access_info() {
    local ip=$(get_local_ip)
    
    echo ""
    separator
    log_info "部署完成！"
    separator
    echo ""
    echo -e "  ${CYAN}🌐 访问地址:${NC}"
    echo "     http://${ip}:1420"
    echo ""
    echo -e "  ${CYAN}📁 配置目录:${NC}"
    echo "     $CONFIG_DIR"
    echo ""
    echo -e "  ${CYAN}📋 容器名称:${NC}"
    echo "     $CONTAINER_NAME"
    echo ""
    echo "  常用命令:"
    echo "    ./docker-deploy.sh logs    # 查看日志"
    echo "    ./docker-deploy.sh status  # 查看状态"
    echo "    ./docker-deploy.sh stop    # 停止"
    echo "    ./docker-deploy.sh start   # 启动"
    echo "    ./docker-deploy.sh restart # 重启"
    echo "    ./docker-deploy.sh rebuild # 重建"
    echo "    ./docker-deploy.sh shell   # 进入容器"
    echo "    ./docker-deploy.sh help    # 帮助"
    echo ""
    separator
    echo ""
}

# -----------------------------------------------------------------------------
# 使用 Docker Compose 方式
# -----------------------------------------------------------------------------
compose_up() {
    if [ -z "$COMPOSE_CMD" ]; then
        log_error "Docker Compose 不可用，请使用单机模式"
        exit 1
    fi
    
    log_step "使用 Docker Compose 启动..."
    
    if [ ! -f "docker-compose.yml" ]; then
        log_error "docker-compose.yml 不存在"
        exit 1
    fi
    
    $COMPOSE_CMD up -d
    log_info "服务已启动"
}

compose_down() {
    if [ -z "$COMPOSE_CMD" ]; then
        log_error "Docker Compose 不可用"
        exit 1
    fi
    
    log_step "停止 Docker Compose 服务..."
    $COMPOSE_CMD down
}

# -----------------------------------------------------------------------------
# 显示帮助
# -----------------------------------------------------------------------------
show_help() {
    echo ""
    echo "ClawPanel Docker 部署脚本"
    echo ""
    echo "用法: $0 [命令]"
    echo ""
    echo "命令:"
    echo "  start     启动容器"
    echo "  stop      停止容器"
    echo "  restart   重启容器"
    echo "  rebuild   重建容器（删除并重新创建）"
    echo "  remove    删除容器（保留镜像）"
    echo "  status    查看容器状态"
    echo "  logs      查看容器日志"
    echo "  shell     进入容器 shell"
    echo "  troubleshoot  常见问题排查"
    echo "  compose   使用 Docker Compose 方式启动"
    echo "  help      显示帮助"
    echo ""
    echo "示例:"
    echo "  $0 start          # 启动容器"
    echo "  $0 logs -f        # 实时查看日志"
    echo "  $0 rebuild        # 重建容器"
    echo ""
}

# -----------------------------------------------------------------------------
# 主流程
# -----------------------------------------------------------------------------
main() {
    case "${1:-help}" in
        check)
            check_docker
            ;;
        build)
            check_docker
            check_requirements
            pull_latest
            build_image
            ;;
        start)
            check_docker
            check_requirements
            start_container
            show_access_info
            ;;
        stop)
            stop_container
            ;;
        restart)
            restart_container
            ;;
        rebuild)
            check_docker
            remove_container
            build_image
            start_container
            show_access_info
            ;;
        remove)
            remove_container
            ;;
        status)
            check_docker
            show_status
            ;;
        logs)
            show_logs
            ;;
        shell)
            enter_container
            ;;
        troubleshoot)
            troubleshoot
            ;;
        compose)
            check_docker
            compose_up
            show_access_info
            ;;
        compose-down)
            compose_down
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            log_error "未知命令: $1"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
