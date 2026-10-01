#!/bin/bash
# ============================================================
# FoodFlow 点餐系统 - 完整卸载脚本
# 用法：sudo bash uninstall.sh
# ============================================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }

# 检查 root 权限
if [ "$EUID" -ne 0 ]; then
    log_error "请使用 root 权限运行：sudo bash $0"
    exit 1
fi

echo ""
echo "=========================================="
echo -e "${RED}  FoodFlow 完整卸载${NC}"
echo "=========================================="
echo ""
log_warn "此操作将删除所有 FoodFlow 相关数据！"
log_warn "包括：应用文件、数据库、配置文件、服务"
echo ""
read -p "确定要卸载吗？输入 yes 继续：" confirm
if [ "$confirm" != "yes" ]; then
    log_info "已取消卸载"
    exit 0
fi
echo ""

# ===== 1. 停止并删除服务 =====
log_info "停止并删除 systemd 服务..."
systemctl stop foodflow 2>/dev/null || true
systemctl disable foodflow 2>/dev/null || true
rm -f /etc/systemd/system/foodflow.service
rm -f /etc/systemd/system/multi-user.target.wants/foodflow.service
systemctl daemon-reload
systemctl reset-failed foodflow 2>/dev/null || true
log_success "服务已删除"

# ===== 2. 删除 Nginx 配置 =====
log_info "删除 Nginx 配置..."
rm -f /etc/nginx/conf.d/foodflow.conf
nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || true
log_success "Nginx 配置已删除"

# ===== 3. 删除应用文件 =====
log_info "删除应用文件..."
rm -rf /var/www/foodflow*
log_success "应用文件已删除"

# ===== 4. 删除配置文件 =====
log_info "删除配置文件..."
rm -rf /etc/foodflow
log_success "配置文件已删除"

# ===== 5. 删除数据库和用户 =====
log_info "删除数据库和用户..."
MYSQL_CMD=""
if mariadb -u root -e "SELECT 1" 2>/dev/null; then
    MYSQL_CMD="mariadb -u root"
elif mysql -u root -e "SELECT 1" 2>/dev/null; then
    MYSQL_CMD="mysql -u root"
fi

if [ -n "$MYSQL_CMD" ]; then
    $MYSQL_CMD -e "DROP DATABASE IF EXISTS ordering_system;" 2>/dev/null || true
    $MYSQL_CMD -e "DROP USER IF EXISTS 'foodflow'@'localhost';" 2>/dev/null || true
    $MYSQL_CMD -e "DROP USER IF EXISTS 'foodflow'@'127.0.0.1';" 2>/dev/null || true
    log_success "数据库和用户已删除"
else
    log_warn "无法连接数据库，跳过数据库删除"
fi

# ===== 6. 删除计划任务 =====
log_info "删除计划任务..."
crontab -l 2>/dev/null | grep -v "auto-backup.sh" | crontab - 2>/dev/null || true
log_success "计划任务已删除"

echo ""
echo "=========================================="
echo -e "${GREEN}  卸载完成！${NC}"
echo "=========================================="
echo ""
echo "已删除的内容："
echo "  - systemd 服务 foodflow"
echo "  - Nginx 配置 /etc/nginx/conf.d/foodflow.conf"
echo "  - 应用目录 /var/www/foodflow*"
echo "  - 配置目录 /etc/foodflow"
echo "  - 数据库 ordering_system"
echo "  - 数据库用户 foodflow"
echo "  - 自动备份计划任务"
echo ""
log_warn "注意：系统软件（Node.js/MariaDB/Redis/Nginx）未卸载"
log_warn "如果需要卸载系统软件，运行："
echo "  sudo apt remove --purge -y nodejs mariadb-server redis-server nginx"
echo "  sudo apt autoremove -y"
echo ""
