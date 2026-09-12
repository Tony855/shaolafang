#!/bin/bash
# ============================================================
# FoodFlow Ordering System - Server Deploy Script
# 用法:
#   首次部署: bash deploy.sh init
#   日常更新: bash deploy.sh update
#   查看状态: bash deploy.sh status
# ============================================================

set -e

# ===== 配置区 =====
PROJECT_DIR="/root/foodflow-main"
GITHUB_TOKEN="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"
REPO_URL="https://${GITHUB_TOKEN}@github.com/Tony855/foodflow.git"
BRANCH="main"
BACKUP_DIR="/root/foodflow-backups"
NODE_PORT=3000

# ===== 颜色输出 =====
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ===== 备份功能 =====
backup() {
    if [ -d "$PROJECT_DIR" ]; then
        mkdir -p "$BACKUP_DIR"
        local backup_name="backup_$(date +%Y%m%d_%H%M%S)"
        info "备份当前代码到 $BACKUP_DIR/$backup_name ..."
        cp -r "$PROJECT_DIR" "$BACKUP_DIR/$backup_name"
        # 只保留最近5个备份
        ls -dt "$BACKUP_DIR"/backup_* 2>/dev/null | tail -n +6 | xargs rm -rf 2>/dev/null || true
        success "备份完成"
    fi
}

# ===== 检查 Node 服务 =====
check_node() {
    if pgrep -f "node server.js" > /dev/null 2>&1; then
        echo "running"
    else
        echo "stopped"
    fi
}

# ===== 重启服务 =====
restart_service() {
    info "重启 Node 服务..."
    # 停止现有进程
    pkill -f "node server.js" 2>/dev/null || true
    sleep 2
    # 启动服务
    cd "$PROJECT_DIR"
    if [ -f "./restart.sh" ]; then
        chmod +x ./restart.sh
        ./restart.sh
    else
        nohup node server.js > /root/foodflow.log 2>&1 &
    fi
    sleep 3
    # 验证
    if curl -s http://localhost:$NODE_PORT/api/health > /dev/null 2>&1; then
        success "服务启动成功，运行在端口 $NODE_PORT"
    else
        warn "服务可能未完全启动，请检查日志: tail -f /root/foodflow.log"
    fi
}

# ===== 首次初始化 =====
init_repo() {
    info "===== 首次部署初始化 ====="
    
    # 备份现有代码
    backup
    
    # 如果目录不存在则创建
    mkdir -p "$PROJECT_DIR"
    cd "$PROJECT_DIR"
    
    # 初始化 git 仓库
    if [ ! -d ".git" ]; then
        info "初始化 Git 仓库..."
        git init
        git remote add origin "$REPO_URL"
    else
        info "Git 仓库已存在，更新 remote..."
        git remote set-url origin "$REPO_URL"
    fi
    
    # 拉取最新代码
    info "从 GitHub 拉取最新代码..."
    git fetch origin
    git checkout -B "$BRANCH" "origin/$BRANCH"
    git reset --hard "origin/$BRANCH"
    git clean -fd
    
    success "代码拉取完成"
    
    # 安装依赖
    info "安装 npm 依赖..."
    npm install --production
    success "依赖安装完成"
    
    # 设置脚本权限
    chmod +x *.sh 2>/dev/null || true
    
    # 重启服务
    restart_service
    
    echo ""
    success "===== 首次部署完成 ====="
    echo "  项目目录: $PROJECT_DIR"
    echo "  访问地址: http://localhost:$NODE_PORT"
    echo "  以后更新只需执行: bash deploy.sh update"
}

# ===== 日常更新 =====
update_repo() {
    info "===== 开始更新代码 ====="
    
    if [ ! -d "$PROJECT_DIR/.git" ]; then
        error "项目未初始化为 Git 仓库，请先执行: bash deploy.sh init"
    fi
    
    cd "$PROJECT_DIR"
    
    # 备份
    backup
    
    # 拉取最新代码
    info "从 GitHub 拉取最新代码..."
    git fetch origin
    git reset --hard "origin/$BRANCH"
    git clean -fd
    
    success "代码更新完成"
    
    # 检查 package.json 是否变化，决定是否重新安装依赖
    if git diff HEAD~1 HEAD --name-only 2>/dev/null | grep -q "package.json"; then
        info "package.json 有变化，重新安装依赖..."
        npm install --production
        success "依赖更新完成"
    fi
    
    # 设置脚本权限
    chmod +x *.sh 2>/dev/null || true
    
    # 重启服务
    restart_service
    
    echo ""
    success "===== 更新完成 ====="
    echo "  最新提交: $(git log -1 --oneline)"
}

# ===== 查看状态 =====
show_status() {
    echo ""
    echo "===== 系统状态 ====="
    echo "  项目目录: $PROJECT_DIR"
    echo "  Node 服务: $(check_node)"
    echo "  Git 分支: $(cd $PROJECT_DIR 2>/dev/null && git branch --show-current 2>/dev/null || echo '未初始化')"
    echo "  最新提交: $(cd $PROJECT_DIR 2>/dev/null && git log -1 --oneline 2>/dev/null || echo 'N/A')"
    echo "  服务端口: $NODE_PORT"
    if curl -s http://localhost:$NODE_PORT/api/health > /dev/null 2>&1; then
        echo "  健康检查: 正常"
    else
        echo "  健康检查: 异常"
    fi
    echo "===================="
    echo ""
}

# ===== 主逻辑 =====
case "${1:-update}" in
    init)
        init_repo
        ;;
    update)
        update_repo
        ;;
    status)
        show_status
        ;;
    restart)
        restart_service
        ;;
    *)
        echo "用法: bash deploy.sh {init|update|status|restart}"
        echo ""
        echo "  init    - 首次部署初始化（转为git仓库并拉取代码）"
        echo "  update  - 日常更新（拉取最新代码并重启）"
        echo "  status  - 查看系统状态"
        echo "  restart - 仅重启服务"
        echo ""
        exit 1
        ;;
esac
