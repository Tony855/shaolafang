#!/bin/bash
# ============================================================
# FoodFlow 企业版 - 集群一键部署脚本
# 适用：多商户/SaaS，多台应用服务器
# 用法：sudo bash deploy.sh [master|slave]
#   master - 主节点（执行定时任务）
#   slave  - 从节点（不执行定时任务）
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
log_info "FoodFlow 企业版 - 集群部署 ($NODE_TYPE)"
log_info "=========================================="

# 1. 系统依赖
apt-get update -qq
apt-get install -y -qq curl wget git nfs-common build-essential

# 2. 安装 Node.js 20
if ! command -v node &> /dev/null; then
    log_info "安装 Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
fi

# 3. 创建目录
id -u www-data &>/dev/null || useradd -r -s /bin/false www-data
mkdir -p /var/www/foodflow/logs /etc/foodflow /mnt/shared/uploads

# 4. 拉取企业版代码
if [ -d /var/www/foodflow/.git ]; then
    cd /var/www/foodflow
    git fetch origin
    git reset --hard origin/main
else
    git clone https://github.com/Tony855/foodflow-enterprise.git /var/www/foodflow
fi

# 5. 安装依赖
cd /var/www/foodflow
npm install --production --no-audit --no-fund

# 6. 配置环境变量
if [ ! -f /etc/foodflow/.env ]; then
    cp deploy/enterprise/cluster/.env.example /etc/foodflow/.env
    log_warn "请编辑 /etc/foodflow/.env 配置数据库、Redis、NFS等"
fi

# 从节点移除定时任务
[ "$NODE_TYPE" == "slave" ] && sed -i '/^RUN_SCHEDULED_TASKS=/d' /etc/foodflow/.env
chmod 600 /etc/foodflow/.env

# 7. 挂载 NFS 共享存储
NFS_SERVER="192.168.1.100"
if ! mountpoint -q /mnt/shared/uploads; then
    if mount -t nfs $NFS_SERVER:/export/uploads /mnt/shared/uploads 2>/dev/null; then
        log_info "NFS 挂载成功"
        echo "$NFS_SERVER:/export/uploads /mnt/shared/uploads nfs defaults,_netdev 0 0" >> /etc/fstab
    else
        log_warn "NFS 挂载失败，请手动配置"
    fi
fi

# 8. 配置 Systemd
cp deploy/enterprise/cluster/foodflow.service /etc/systemd/system/foodflow.service
systemctl daemon-reload
systemctl enable foodflow
chown -R www-data:www-data /var/www/foodflow

# 9. 启动服务
systemctl restart foodflow
sleep 3

if systemctl is-active --quiet foodflow; then
    log_info "企业版服务启动成功"
else
    log_error "启动失败，请查看日志：journalctl -u foodflow -f"
    exit 1
fi

log_info "=========================================="
log_info "企业版节点部署完成！类型：$NODE_TYPE"
log_info "=========================================="
echo "应用目录：/var/www/foodflow"
echo "环境变量：/etc/foodflow/.env"
echo "服务管理：systemctl [start|stop|restart|status] foodflow"
echo "查看日志：journalctl -u foodflow -f"
