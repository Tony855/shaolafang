#!/bin/bash
# ============================================================
# FoodFlow 点餐系统 - 单台一键部署脚本
# 适用：Debian/Ubuntu，1-50家门店
# 用法：sudo bash deploy.sh
# ============================================================

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

if [ "$EUID" -ne 0 ]; then
    log_error "请使用 root 用户运行此脚本"
    exit 1
fi

log_info "=========================================="
log_info "FoodFlow 单台服务器部署"
log_info "=========================================="

# 1. 系统更新
log_info "更新系统软件包..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget git nginx build-essential

# 2. 安装 MySQL
if ! command -v mysql &> /dev/null; then
    log_info "安装 MySQL 8.0..."
    apt-get install -y -qq mysql-server
    systemctl enable mysql
    systemctl start mysql
else
    log_info "MySQL 已安装"
fi

# 3. 安装 Redis（可选）
if ! command -v redis-server &> /dev/null; then
    log_info "安装 Redis..."
    apt-get install -y -qq redis-server
    systemctl enable redis-server
    systemctl start redis
else
    log_info "Redis 已安装"
fi

# 4. 安装 Node.js 20
if ! command -v node &> /dev/null || [ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt 18 ]; then
    log_info "安装 Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
else
    log_info "Node.js 已安装：$(node -v)"
fi

# 5. 创建目录
log_info "创建应用目录..."
id -u www-data &>/dev/null || useradd -r -s /bin/false www-data
mkdir -p /var/www/foodflow/{uploads,backups,logs}
mkdir -p /etc/foodflow

# 6. 拉取代码
log_info "拉取应用代码..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

if [ -d "$PROJECT_DIR/.git" ]; then
    cp -r "$PROJECT_DIR"/* /var/www/foodflow/
    cd /var/www/foodflow
else
    git clone https://github.com/Tony855/foodflow-standard.git /var/www/foodflow
    cd /var/www/foodflow
fi

# 7. 安装依赖
log_info "安装 Node.js 依赖..."
npm install --production --no-audit --no-fund

# 8. 配置环境变量
if [ ! -f /etc/foodflow/.env ]; then
    cp deploy/single/.env.example /etc/foodflow/.env
    log_warn "请编辑 /etc/foodflow/.env 配置数据库密码等信息"
fi
chmod 600 /etc/foodflow/.env

# 9. 配置 Systemd
log_info "配置 Systemd 服务..."
cp deploy/single/foodflow.service /etc/systemd/system/foodflow.service
systemctl daemon-reload
systemctl enable foodflow
chown -R www-data:www-data /var/www/foodflow

# 10. 配置 Nginx
if [ -f deploy/single/nginx.conf ]; then
    cp deploy/single/nginx.conf /etc/nginx/conf.d/foodflow.conf
    nginx -t 2>/dev/null && systemctl reload nginx
fi

# 11. 启动服务
log_info "启动服务..."
systemctl restart foodflow
sleep 3

if systemctl is-active --quiet foodflow; then
    log_info "FoodFlow 服务启动成功！"
else
    log_error "启动失败，请查看日志：journalctl -u foodflow -f"
    exit 1
fi

log_info "=========================================="
log_info "单台部署完成！"
log_info "=========================================="
echo "应用目录：/var/www/foodflow"
echo "环境变量：/etc/foodflow/.env"
echo "服务管理：systemctl [start|stop|restart|status] foodflow"
echo "查看日志：journalctl -u foodflow -f"
log_warn "请配置SSL证书：sudo certbot --nginx -d your-domain.com"
