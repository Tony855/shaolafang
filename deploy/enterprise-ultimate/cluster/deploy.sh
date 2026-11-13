#!/bin/bash
# ============================================================
# FoodFlow 企业旗舰版 - 集群一键部署脚本
# 适用：多商户/SaaS，多台应用服务器，可水平扩展
# 用法：sudo bash deploy.sh [master|slave]
#   master - 主节点（执行定时任务）
#   slave  - 从节点（不执行定时任务）
#
# 注意：集群部署需要独立的 MySQL、Redis、NFS 服务器，
# 请先编辑 /etc/foodflow/.env 配置正确的连接信息
# ============================================================

set -e

# 设置非交互模式
export DEBIAN_FRONTEND=noninteractive

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../../scripts/lib/system-deps.sh
source "$REPO_ROOT/scripts/lib/system-deps.sh"

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
    log_error "请使用 root 用户运行"
    exit 1
fi

NODE_TYPE=${1:-master}
echo ""
echo "=========================================="
echo "  FoodFlow 企业旗舰版 - 集群部署 ($NODE_TYPE)"
echo "=========================================="
echo ""

# ===== 1. 安装基础工具 =====
log_info "安装基础工具..."
ff_prepare_system_packages curl wget git nfs-common build-essential
log_success "基础工具安装完成"

# ===== 2. 安装/升级 Node.js 26 LTS =====
ff_ensure_node

# ===== 3. 创建目录 =====
log_info "创建目录..."
if ! getent group www-data >/dev/null 2>&1; then
    groupadd --system --gid 33 www-data
fi
if ! getent passwd www-data >/dev/null 2>&1; then
    useradd --system --no-create-home --uid 33 --gid 33 --shell /usr/sbin/nologin www-data
fi
if [ "$(id -u www-data)" != "33" ] || [ "$(id -g www-data)" != "33" ]; then
    log_error "集群 NFS 要求所有应用节点的 www-data UID/GID 为 33:33；请先统一账号 ID"
    exit 1
fi
mkdir -p /var/www/foodflow/{logs,uploads,backups} /etc/foodflow /mnt/shared/uploads
log_success "目录创建完成"

# ===== 4. 部署代码 =====
log_info "部署代码到 /var/www/foodflow..."
if [ -d /var/www/foodflow/.git ]; then
    log_info "检测到已部署，执行 git pull 更新..."
    cd /var/www/foodflow
    if [ -n "$(git status --porcelain)" ]; then
        log_error "部署目录存在未提交修改；为避免覆盖人工变更，已停止更新"
        exit 1
    fi
    git fetch origin && git pull --ff-only origin main
else
    log_info "克隆代码仓库..."
    if [ -d "/var/www/foodflow" ] && [ "$(ls -A /var/www/foodflow)" ]; then
        BACKUP_DIR="/var/www/foodflow.backup.$(date +%Y%m%d%H%M%S)"
        log_warn "目录已存在且非空，备份到 $BACKUP_DIR"
        mv /var/www/foodflow "$BACKUP_DIR"
    fi
    git clone https://github.com/Tony855/foodflow-enterprise-ultimate.git /var/www/foodflow
fi
log_success "代码部署完成"

# ===== 5. 安装依赖 =====
log_info "安装 Node.js 依赖..."
cd /var/www/foodflow
ff_npm_ci_production
log_success "依赖安装完成"

# ===== 6. 配置环境变量 =====
if [ ! -f /etc/foodflow/.env ]; then
    cp deploy/enterprise-ultimate/cluster/.env.example /etc/foodflow/.env
    log_warn "已创建 /etc/foodflow/.env，请编辑配置数据库、Redis、NFS 连接信息"
fi

# 从节点不执行定时任务
if [ "$NODE_TYPE" == "slave" ]; then
    sed -i '/^RUN_SCHEDULED_TASKS=/d' /etc/foodflow/.env
    echo "RUN_SCHEDULED_TASKS=false" >> /etc/foodflow/.env
    log_info "从节点：已禁用定时任务"
fi
chmod 600 /etc/foodflow/.env

# Validate runtime configuration before touching the service.
set -a
# shellcheck disable=SC1091
source /etc/foodflow/.env
set +a
if [[ ! "${DB_DATABASE:-}" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    log_error "DB_DATABASE 缺失或格式无效；请编辑 /etc/foodflow/.env（不能使用 DB_NAME）"
    exit 1
fi
if [ -z "${DB_HOST:-}" ] || [ -z "${DB_USER:-}" ] || [ -z "${DB_PASSWORD:-}" ]; then
    log_error "DB_HOST、DB_USER 和 DB_PASSWORD 必须全部配置"
    exit 1
fi
if [ "${DB_USER}" = "root" ]; then
    log_error "应用数据库禁止使用 MySQL root；请创建独立的 foodflow 数据库账号"
    exit 1
fi
if [[ "${DB_HOST}" == *".example.com" ]]; then
    log_error "DB_HOST 仍是示例占位地址，请替换为真实数据库主机"
    exit 1
fi
if [ "${#DB_PASSWORD}" -lt 20 ] || [ "${DB_PASSWORD}" = "YourStrongPasswordHere" ]; then
    log_error "DB_PASSWORD 太短或仍是示例密码；请设置至少 20 个字符的强随机密码"
    exit 1
fi
if [ -z "${JWT_SECRET:-}" ] || [ "${#JWT_SECRET}" -lt 32 ] || [[ "${JWT_SECRET}" == ChangeThisToARandomString* ]]; then
    log_error "JWT_SECRET 缺失、太短或仍是示例密钥；请设置至少 32 个字符的随机密钥"
    exit 1
fi
if [ -z "${QR_DOMAIN:-}" ] || [ "${QR_DOMAIN}" = "https://your-domain.com" ]; then
    log_error "QR_DOMAIN 仍是示例域名，请设置实际对外 HTTPS 域名"
    exit 1
fi
if [ -z "${REDIS_URL:-}" ]; then
    log_error "集群部署必须配置 REDIS_URL；禁止在多节点模式回退到进程内存状态"
    exit 1
fi
if [[ "${REDIS_URL}" == *".example.com"* || "${REDIS_URL}" == *"redis_password"* ]]; then
    log_error "REDIS_URL 仍包含示例主机或占位密码，请替换为真实 Redis 连接串"
    exit 1
fi

# Verify Redis is reachable; merely setting REDIS_URL must not permit an in-memory cluster fallback.
if ! REDIS_URL="$REDIS_URL" node <<'NODE'
const { createClient } = require('redis');
(async () => {
  const client = createClient({
    url: process.env.REDIS_URL,
    socket: { connectTimeout: 5000, reconnectStrategy: false }
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') throw new Error('unexpected PING response');
    await client.quit();
  } catch (error) {
    try { client.disconnect(); } catch (_) {}
    process.exitCode = 1;
  }
})();
NODE
then
    log_error "Redis 连接或 PING 检查失败；集群节点不得回退到进程内存状态"
    exit 1
fi
if [ -z "${TRUST_PROXY:-}" ] || [ "${TRUST_PROXY}" = "loopback" ] || [ "${TRUST_PROXY}" = "192.168.1.10/32" ] || [ "${TRUST_PROXY}" = "true" ]; then
    log_error "请将 TRUST_PROXY 设置为实际 Nginx 负载均衡器的可信内网 IP/CIDR；禁止使用占位值或 true"
    exit 1
fi
log_success "数据库、Redis 和可信代理配置检查通过"

# Cluster nodes must use the shared NFS mount, not a node-local uploads directory.
if [ "${UPLOAD_DIR:-/mnt/shared/uploads}" != "/mnt/shared/uploads" ]; then
    log_error "集群 UPLOAD_DIR 必须设置为 /mnt/shared/uploads（与 systemd ReadWritePaths 一致）"
    exit 1
fi
if ! mountpoint -q /mnt/shared/uploads; then
    log_error "NFS 上传目录尚未挂载；请先挂载 NFS_SERVER:/export/uploads 到 /mnt/shared/uploads"
    exit 1
fi
UPLOAD_FS_TYPE="$(findmnt -n -o FSTYPE --target /mnt/shared/uploads 2>/dev/null || true)"
case "$UPLOAD_FS_TYPE" in
    nfs|nfs4) ;;
    *)
        log_error "共享上传目录必须是真正的 NFS 文件系统，当前类型：${UPLOAD_FS_TYPE:-unknown}"
        exit 1
        ;;
esac
if ! runuser -u www-data -- test -w /mnt/shared/uploads; then
    log_error "www-data（UID/GID 33:33）无法写入 NFS 上传目录；请检查服务端目录属主/权限和 root_squash 配置"
    exit 1
fi
log_success "NFS 上传挂载及 www-data 写入权限验证通过"

# ===== 7. NFS 已在上方完成挂载与权限验证 =====
log_info "NFS 共享存储已验证，继续配置应用服务..."

# ===== 8. 配置 Systemd =====
log_info "配置 Systemd 服务..."
cp deploy/enterprise-ultimate/cluster/foodflow.service /etc/systemd/system/foodflow.service
systemctl daemon-reload
systemctl enable foodflow
chown -R root:www-data /var/www/foodflow
install -d -o www-data -g www-data -m 0770 /var/www/foodflow/logs /var/www/foodflow/backups
install -d -o www-data -g www-data -m 0700 /var/lib/foodflow
log_success "Systemd 服务配置完成"

# ===== 9. 启动服务 =====
log_info "启动服务..."
systemctl restart foodflow || true
sleep 5

if systemctl is-active --quiet foodflow; then
    log_success "服务启动成功！"
else
    log_error "服务启动失败，请查看日志：journalctl -u foodflow -n 50 --no-pager"
    log_warn "可能原因：数据库/Redis/NFS 配置不正确，请检查 /etc/foodflow/.env"
    exit 1
fi

# A running systemd process is not enough: wait for the HTTP readiness endpoint,
# which verifies that the application can execute a MySQL query.
READY_URL="http://127.0.0.1:${PORT:-3000}/api/health/ready"
READY_STATUS=""
for attempt in $(seq 1 15); do
    READY_STATUS="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 3 "$READY_URL" 2>/dev/null || true)"
    if [ "$READY_STATUS" = "200" ]; then
        break
    fi
    sleep 2
done
if [ "$READY_STATUS" != "200" ]; then
    log_error "应用进程已启动，但数据库 readiness 检查未通过（HTTP ${READY_STATUS:-no response}）"
    journalctl -u foodflow -n 50 --no-pager || true
    exit 1
fi
log_success "HTTP readiness 检查通过，MySQL 查询正常"

# ===== 完成 =====
echo ""
echo "=========================================="
echo -e "${GREEN}  部署完成！节点类型：$NODE_TYPE${NC}"
echo "=========================================="
echo ""
echo "应用目录：/var/www/foodflow"
echo "环境变量：/etc/foodflow/.env"
echo "服务管理：systemctl [start|stop|restart|status] foodflow"
echo "查看日志：journalctl -u foodflow -f"
echo ""
if [ "$NODE_TYPE" == "master" ]; then
    log_info "主节点：定时任务已启用（自动备份、日志清理）"
else
    log_info "从节点：定时任务未启用（由主节点执行）"
fi
echo ""
log_warn "重要提示："
echo "  1. 请确保 /etc/foodflow/.env 中的数据库、Redis、NFS 配置正确"
echo "  2. 所有节点的数据库、Redis、NFS 配置必须完全相同"
echo "  3. 请配置 Nginx 负载均衡（参考 deploy/enterprise-ultimate/cluster/nginx.conf）"
echo "  4. 建议配置 SSL 证书"
echo "  5. 超级管理员后台: https://your-domain.com/super (初始密码为随机生成，见 /var/lib/foodflow/initial-credentials.txt)"
echo ""
