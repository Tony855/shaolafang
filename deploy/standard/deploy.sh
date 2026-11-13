#!/bin/bash
# ============================================================
# FoodFlow 点餐系统 - 单台一键部署脚本
# 适用：Debian/Ubuntu，1-50家门店
# 用法：sudo bash deploy.sh
#
# 本脚本会将代码部署到 /var/www/foodflow，
# 然后调用 install-local.sh 完成后续安装（数据库、Redis、Node.js、Systemd、Nginx）
# ============================================================

set -Ee

# 设置非交互模式
export DEBIAN_FRONTEND=noninteractive

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }

if [ "$EUID" -ne 0 ]; then
    log_error "请使用 root 用户运行此脚本"
    exit 1
fi

echo ""
echo "=========================================="
echo "  FoodFlow 单台服务器部署"
echo "=========================================="
echo ""

# ===== 获取脚本所在目录和项目根目录 =====
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
DEPLOY_TARGET="/var/www/foodflow"
# shellcheck source=../../scripts/lib/system-deps.sh
source "$PROJECT_DIR/scripts/lib/system-deps.sh"
# shellcheck source=../../scripts/lib/deploy-safety.sh
source "$PROJECT_DIR/scripts/lib/deploy-safety.sh"
ff_enable_error_trap

ff_acquire_deploy_lock

log_info "项目源目录: $PROJECT_DIR"
log_info "部署目标目录: $DEPLOY_TARGET"

# ===== 1. 安装基础工具 =====
log_info "安装基础工具..."
ff_prepare_system_packages curl wget git
log_success "基础工具安装完成"

# ===== 2. 部署代码到 /var/www/foodflow =====
echo ""
log_info "部署代码到 $DEPLOY_TARGET..."

# 创建目标目录
mkdir -p "$DEPLOY_TARGET"

REPO_NAME="$(basename "$PROJECT_DIR")"
case "$REPO_NAME" in
    *enterprise-ultimate*|*ultimate*)
        GIT_REPO="https://github.com/Tony855/foodflow-enterprise-ultimate.git"
        ;;
    *enterprise*)
        GIT_REPO="https://github.com/Tony855/foodflow-enterprise.git"
        ;;
    *)
        GIT_REPO="https://github.com/Tony855/shaolafang.git"
        ;;
esac

if [ -d "$DEPLOY_TARGET/.git" ]; then
    log_info "检测到 Git 部署目录，检查工作区后执行安全快进更新..."
    cd "$DEPLOY_TARGET"
    ff_require_clean_git_worktree
    git pull --ff-only origin main
    log_success "代码快进更新完成"
elif [ -n "$(ls -A "$DEPLOY_TARGET" 2>/dev/null)" ]; then
    log_error "目标目录非空但不是 Git 仓库；为保护生产配置和数据，拒绝备份搬移或覆盖。"
    log_error "请先备份并将现有实例迁移到 Git 管理目录，再重新部署。"
    exit 1
else
    log_info "首次部署，克隆代码仓库: $GIT_REPO"
    git clone "$GIT_REPO" "$DEPLOY_TARGET"
    log_success "代码克隆完成"
fi

# 创建必要的子目录
mkdir -p "$DEPLOY_TARGET"/{uploads,backups,logs}

# ===== 3. 调用 install-local.sh 完成后续安装 =====
echo ""
log_info "调用 install-local.sh 完成后续安装（数据库、Redis、Node.js、Systemd、Nginx）..."
echo ""

if [ ! -f "$DEPLOY_TARGET/install-local.sh" ]; then
    log_error "未找到 install-local.sh，请确保代码完整"
    exit 1
fi

cd "$DEPLOY_TARGET"
if [ -f "$DEPLOY_TARGET/.env" ]; then
    log_info "检测到已有生产配置，使用安全升级流程（保留当前源码）..."
    FF_DEPLOY_LOCK_HELD=1 SKIP_GIT_UPDATE=1 bash "$DEPLOY_TARGET/remote-update.sh"
else
    bash install-local.sh
fi

# ===== 完成 =====
echo ""
echo "=========================================="
echo -e "${GREEN}  单台部署完成！${NC}"
echo "=========================================="
echo ""
echo "应用目录：$DEPLOY_TARGET"
echo "环境变量：$DEPLOY_TARGET/.env"
echo "服务管理：systemctl [start|stop|restart|status] foodflow"
echo "查看日志：journalctl -u foodflow -f"
echo ""
echo "首次登录用户名: superadmin / admin"
echo "首次密码: 由系统随机生成，读取 /var/lib/foodflow/initial-credentials.txt"
echo ""
log_warn "首次登录后请立即修改所有初始密码"
log_warn "建议配置 SSL 证书: cd $DEPLOY_TARGET && sudo bash setup-nginx.sh"
echo ""
