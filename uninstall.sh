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
log_warn "此操作将卸载 FoodFlow 程序和服务。"
log_warn "数据库、配置文件、上传文件和备份默认保留，避免误删生产数据。"
log_warn "如确实需要删除数据，请在后续提示中输入 DELETE ALL DATA。"
echo ""
read -p "确定要卸载程序吗？输入 yes 继续：" confirm
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
if [ -d /var/www/foodflow ]; then
    DATA_ARCHIVE="/var/backups/foodflow-uninstall-$(date +%Y%m%d%H%M%S)"
    mkdir -p "$DATA_ARCHIVE"
    [ -d /var/www/foodflow/uploads ] && cp -a /var/www/foodflow/uploads "$DATA_ARCHIVE/" || true
    [ -d /var/www/foodflow/backups ] && cp -a /var/www/foodflow/backups "$DATA_ARCHIVE/" || true
    chmod 700 "$DATA_ARCHIVE"
    rm -rf -- /var/www/foodflow
    log_success "应用程序目录已删除（uploads/backups 已先保留到独立归档）"
fi

# ===== 4. 删除配置文件 =====
log_info "删除配置文件..."
if [ -d /etc/foodflow ]; then
    cp -a /etc/foodflow "/var/backups/foodflow-config-$(date +%Y%m%d%H%M%S)"
    log_success "配置文件已归档，保留原目录"
fi

# ===== 5. 数据库默认保留 =====
log_warn "数据库 foodflow_system 和 foodflow 数据库用户默认保留。"
if [ "${PURGE_FOODFLOW_DATA:-0}" = "1" ]; then
    read -p "输入 DELETE ALL DATA 确认永久删除数据库 foodflow_system：" purge_confirm
    if [ "$purge_confirm" = "DELETE ALL DATA" ]; then
        MYSQL_CMD=""
        if mariadb -u root -e "SELECT 1" 2>/dev/null; then MYSQL_CMD="mariadb -u root"
        elif mysql -u root -e "SELECT 1" 2>/dev/null; then MYSQL_CMD="mysql -u root"; fi
        if [ -n "$MYSQL_CMD" ]; then
            $MYSQL_CMD -e "DROP DATABASE IF EXISTS foodflow_system;"
            $MYSQL_CMD -e "DROP USER IF EXISTS 'foodflow'@'localhost';"
            $MYSQL_CMD -e "DROP USER IF EXISTS 'foodflow'@'127.0.0.1';"
            log_success "数据库和用户已删除"
        else
            log_warn "无法连接数据库，未删除数据库和用户"
        fi
    else
        log_warn "未输入确认短语，数据库数据保持不变"
    fi
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
echo "  - 应用目录 /var/www/foodflow"
echo "保留的数据："
echo "  - 数据库 foodflow_system 和数据库用户 foodflow（默认保留）"
echo "  - /etc/foodflow 配置目录（已归档，原目录保留）"
echo "  - /var/lib/foodflow 初始凭据和运行状态目录"
echo "  - 上传文件和备份的归档副本位于 /var/backups/"
echo "  - 自动备份计划任务"
echo ""
log_warn "注意：系统软件（Node.js/MariaDB/Redis/Nginx）未卸载"
log_warn "如果需要卸载系统软件，运行："
echo "  sudo apt remove --purge -y nodejs mariadb-server redis-server nginx"
echo "  sudo apt autoremove -y"
echo ""
