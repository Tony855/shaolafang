#!/bin/bash
# ============================================================
# FoodFlow 标准版 - 集群一键部署脚本
# 用法：sudo bash deploy.sh [master|slave]
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
    log_error "请使用 root 用户运行"
    exit 1
fi

NODE_TYPE=${1:-master}
log_info "=========================================="
log_info "FoodFlow 标准版 - 集群部署 ($NODE_TYPE)"
log_info "=========================================="

apt-get update -qq
apt-get install -y -qq curl wget git nfs-common build-essential

if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
fi

id -u www-data &>/dev/null || useradd -r -s /bin/false www-data
mkdir -p /var/www/foodflow/logs /etc/foodflow /mnt/shared/uploads

if [ -d /var/www/foodflow/.git ]; then
    cd /var/www/foodflow && git fetch origin && git reset --hard origin/main
else
    git clone https://github.com/Tony855/foodflow-standard.git /var/www/foodflow
fi

cd /var/www/foodflow && npm install --production --no-audit --no-fund

if [ ! -f /etc/foodflow/.env ]; then
    cp deploy/standard/cluster/.env.example /etc/foodflow/.env
    log_warn "请编辑 /etc/foodflow/.env 配置数据库、Redis、NFS"
fi

[ "$NODE_TYPE" == "slave" ] && sed -i '/^RUN_SCHEDULED_TASKS=/d' /etc/foodflow/.env
chmod 600 /etc/foodflow/.env

NFS_SERVER="192.168.1.100"
if ! mountpoint -q /mnt/shared/uploads; then
    mount -t nfs $NFS_SERVER:/export/uploads /mnt/shared/uploads 2>/dev/null && \
    echo "$NFS_SERVER:/export/uploads /mnt/shared/uploads nfs defaults,_netdev 0 0" >> /etc/fstab || \
    log_warn "NFS挂载失败，请手动配置"
fi

cp deploy/standard/cluster/foodflow.service /etc/systemd/system/foodflow.service
systemctl daemon-reload && systemctl enable foodflow
chown -R www-data:www-data /var/www/foodflow

systemctl restart foodflow && sleep 3
systemctl is-active --quiet foodflow && log_info "服务启动成功" || log_error "启动失败"

log_info "=========================================="
log_info "部署完成！节点类型：$NODE_TYPE"
log_info "=========================================="
