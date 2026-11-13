#!/bin/bash
# ============================================================
# FoodFlow 本地一键安装脚本（无需拉取代码）
# 适用场景：代码已在当前目录，直接安装部署
#
# 使用方法：
#   cd /path/to/foodflow
#   sudo bash install-local.sh
#
# 支持系统：Debian 12/13、Ubuntu 22.04/24.04
# ============================================================

set -Ee


# ===== 颜色输出 =====
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $1"; }

# 安全检查：如果当前仓库历史中存在 GitHub Token 模式，提示运维人员检查。
if git log --all --oneline 2>/dev/null | grep -q "ghp_"; then
    log_warn "检测到 Git 历史中可能存在 GitHub Token 痕迹。请撤销相关凭据并检查历史。"
fi

# ===== 检查 root 权限 =====
if [ "$EUID" -ne 0 ]; then
    log_error "请使用 root 权限运行：sudo bash $0"
    exit 1
fi

# 设置非交互模式，避免 apt 安装时弹出键盘布局等交互界面
export DEBIAN_FRONTEND=noninteractive

# ===== 全局路径配置（和 install.sh 保持一致）=====
DEFAULT_DIR="/var/www/foodflow"
CONFIG_DIR="/etc/foodflow"
SERVICE_NAME="foodflow"
FF_INSTALL_REDIS="${FF_INSTALL_REDIS:-0}"
FF_CONFIGURE_UFW="${FF_CONFIGURE_UFW:-0}"
FF_CONFIGURE_BACKUP_CRON="${FF_CONFIGURE_BACKUP_CRON:-0}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Acquire the deployment lock before any fallback clone or filesystem mutation.
# shellcheck source=scripts/lib/deploy-safety.sh
source "$APP_DIR/scripts/lib/deploy-safety.sh"
ff_enable_error_trap
ff_acquire_deploy_lock

# 如果当前目录没有 server.js，则安装到默认路径
if [ ! -f "$APP_DIR/server.js" ]; then
    APP_DIR="$DEFAULT_DIR"
    log_info "未找到 server.js，安装到默认路径: $APP_DIR"
    mkdir -p "$APP_DIR"
    cd "$APP_DIR"
    if [ ! -f server.js ]; then
        log_info "拉取仓库到 $APP_DIR..."
    
        REPO_URL="https://github.com/Tony855/shaolafang.git"
        log_info "使用公开仓库 HTTPS 方式拉取"
        git clone "$REPO_URL" .
    fi
    log_success "代码已就位: $APP_DIR"
else
    log_info "应用目录: $APP_DIR"
fi

# ===== 检查核心文件 =====
if [ ! -f "$APP_DIR/server.js" ]; then
    log_error "当前目录未找到 server.js"
    exit 1
fi

if [ ! -f "$APP_DIR/package.json" ]; then
    log_error "当前目录未找到 package.json"
    exit 1
fi

# shellcheck source=scripts/lib/system-deps.sh
source "$APP_DIR/scripts/lib/system-deps.sh"
# shellcheck source=scripts/lib/deploy-safety.sh
source "$APP_DIR/scripts/lib/deploy-safety.sh"
ff_acquire_deploy_lock

# 本脚本仅用于首次初始化；已有 .env 的实例应使用安全升级流程。
if [ -e "$APP_DIR/.env" ]; then
    log_error "检测到已有 .env，拒绝执行首次安装以免重置生产配置。"
    log_error "请使用 install.sh 的更新模式，或先完成独立备份和迁移。"
    exit 1
fi

echo ""
echo "=========================================="
echo "  FoodFlow 本地一键安装"
echo "=========================================="
echo "应用目录: $APP_DIR"
echo "操作系统: $(cat /etc/os-release | grep PRETTY_NAME | cut -d'"' -f2)"
echo "=========================================="
echo ""

# ===== 1. 更新系统 =====
log_info "更新系统软件包..."
ff_prepare_system_packages curl wget git nginx
log_success "系统基础依赖已准备完成"

# ===== 2. 安装 MariaDB =====
echo ""
log_info "检查数据库..."
DB_INSTALLED=false
# 严格检测：必须同时具备 mariadbd/mysqld 二进制 + systemd unit
if { command -v mariadbd &>/dev/null || command -v mysqld &>/dev/null; } \
   && systemctl list-unit-files 2>/dev/null | grep -qE '^(mariadb|mysql)\.service'; then
    DB_INSTALLED=true
    systemctl start mariadb 2>/dev/null || systemctl start mysql 2>/dev/null || true
    log_success "MariaDB/MySQL 已安装"
else
    log_info "安装 MariaDB（兼容MySQL）..."
    # 清除 client-only 残骸，否则 apt 会跳过主包安装
    if command -v mariadb &>/dev/null || command -v mysql &>/dev/null; then
        log_warn "检测到 MariaDB client 残骸，先清理再重装..."
        log_warn "保留现有数据库目录和配置，不执行 purge 或删除 /var/lib/mysql。"
        log_warn "将直接尝试安装 MariaDB Server；若失败请先人工检查数据库服务状态。"
    fi
    ff_apt_install mariadb-server
    mkdir -p /run/mysqld
    chown mysql:mysql /run/mysqld
    systemctl enable mariadb
    systemctl start mariadb
    sleep 2
    if ! systemctl is-active --quiet mariadb; then
        log_error "MariaDB 启动失败，请检查: journalctl -u mariadb -n 30"
        exit 1
    fi
    log_success "MariaDB 安装完成"
fi

# 确保数据库服务运行
systemctl start mariadb 2>/dev/null || systemctl start mysql 2>/dev/null || true

# ===== 可选：Redis（单机首次安装默认使用进程内缓存） =====
if [ "$FF_INSTALL_REDIS" = "1" ]; then
    log_info "按 FF_INSTALL_REDIS=1 安装并启用 Redis..."
    if ! command -v redis-server >/dev/null 2>&1; then ff_apt_install redis-server; fi
    systemctl enable redis-server
    systemctl start redis-server 2>/dev/null || systemctl start redis
    if [ -f /etc/redis/redis.conf ]; then
        if grep -q '^appendonly no' /etc/redis/redis.conf; then
            sed -i 's/^appendonly no/appendonly yes/' /etc/redis/redis.conf
        elif ! grep -q '^appendonly yes' /etc/redis/redis.conf; then
            echo 'appendonly yes' >> /etc/redis/redis.conf
        fi
        grep -q '^appendfsync' /etc/redis/redis.conf || echo 'appendfsync everysec' >> /etc/redis/redis.conf
        systemctl restart redis-server 2>/dev/null || systemctl restart redis 2>/dev/null || true
    fi
else
    log_info "跳过 Redis；单机默认使用进程内缓存。多节点部署必须配置共享 Redis。"
fi

# ===== 4. 安装/升级 Node.js 26 LTS =====
echo ""
ff_ensure_node

# ===== 5. 安装 npm 依赖 =====
echo ""
log_info "安装 Node.js 依赖..."
cd "$APP_DIR"
ff_npm_ci_production
log_success "依赖安装完成"

# ===== 6. 创建必要目录 =====
echo ""
log_info "创建必要目录..."
mkdir -p "$APP_DIR"/{uploads,backups,logs}
mkdir -p "$CONFIG_DIR"
# 给 www-data 读取权限（Nginx 需要）
chown -R root:www-data "$APP_DIR"
chmod -R 755 "$APP_DIR"
chmod -R 775 "$APP_DIR/uploads"
log_success "目录创建完成，权限已配置"

# ===== 7. 自动配置数据库和环境变量 =====
echo ""
log_info "自动配置数据库..."

# 7.1 数据库名（固定，不做不可靠的自动检测）
DEFAULT_DB_NAME="foodflow_system"
log_info "数据库名: $DEFAULT_DB_NAME"

# 7.2 生成随机密码
DB_RANDOM_PASSWORD=$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)
JWT_RANDOM_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)

# 7.3 找到可用的 mysql 命令（处理 MariaDB unix_socket 认证）
MYSQL_CMD=""
if mariadb -u root -e "SELECT 1" 2>/dev/null; then
    MYSQL_CMD="mariadb -u root"
elif mysql -u root -e "SELECT 1" 2>/dev/null; then
    MYSQL_CMD="mysql -u root"
elif sudo mariadb -u root -e "SELECT 1" 2>/dev/null; then
    MYSQL_CMD="sudo mariadb -u root"
elif sudo mysql -u root -e "SELECT 1" 2>/dev/null; then
    MYSQL_CMD="sudo mysql -u root"
fi

if [ -z "$MYSQL_CMD" ]; then
    log_error "无法以 root 身份登录数据库，请检查 MariaDB 是否安装并启动"
    exit 1
fi

# 7.4 安全创建数据库：已有业务库时绝不自动删除或覆盖。
log_info "检查数据库是否已存在..."
DB_EXISTS=$($MYSQL_CMD -N -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME='$DEFAULT_DB_NAME';")
if [ "${DB_EXISTS:-0}" -gt 0 ]; then
    log_error "数据库 $DEFAULT_DB_NAME 已存在。为保护生产数据，安装程序拒绝 DROP/覆盖。"
    log_error "请先完成独立备份；已有系统升级请使用升级流程，不要重新初始化数据库。"
    exit 1
fi
log_info "创建全新数据库..."
$MYSQL_CMD -e "CREATE DATABASE \`$DEFAULT_DB_NAME\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 7.5 创建数据库用户（先删除旧用户，确保密码正确）
log_info "创建数据库用户..."
$MYSQL_CMD -e "DROP USER IF EXISTS 'foodflow'@'localhost';"
$MYSQL_CMD -e "DROP USER IF EXISTS 'foodflow'@'127.0.0.1';"
$MYSQL_CMD -e "CREATE USER 'foodflow'@'localhost' IDENTIFIED BY '$DB_RANDOM_PASSWORD';"
$MYSQL_CMD -e "CREATE USER 'foodflow'@'127.0.0.1' IDENTIFIED BY '$DB_RANDOM_PASSWORD';"
$MYSQL_CMD -e "GRANT ALL PRIVILEGES ON \`$DEFAULT_DB_NAME\`.* TO 'foodflow'@'localhost';"
$MYSQL_CMD -e "GRANT ALL PRIVILEGES ON \`$DEFAULT_DB_NAME\`.* TO 'foodflow'@'127.0.0.1';"
$MYSQL_CMD -e "FLUSH PRIVILEGES;"

# 7.6 验证数据库连接（测试脚本写在项目目录下，才能找到node_modules）
log_info "验证数据库连接..."

# 写入测试脚本到项目目录（必须在项目目录才能找到 mysql2 模块）
cat > "$APP_DIR/db-test.js" << EOF
const mysql = require('mysql2/promise');
const conn = mysql.createConnection({
  host: '127.0.0.1', port: 3306,
  user: 'foodflow', password: '$DB_RANDOM_PASSWORD',
  database: '$DEFAULT_DB_NAME',
  connectTimeout: 5000
});
conn.then(c => { console.log('OK'); c.end(); process.exit(0); })
    .catch(e => { console.log('FAIL:', e.message); process.exit(1); });
EOF

# 在项目目录下执行，最多等10秒
cd "$APP_DIR"
if timeout 10 node db-test.js; then
    log_success "数据库和用户创建成功，连接测试通过"
else
    log_error "数据库连接测试失败，请检查 MariaDB 配置"
    rm -f "$APP_DIR/db-test.js"
    exit 1
fi
rm -f "$APP_DIR/db-test.js"

# 7.7 写入 .env 文件（始终覆盖）
ENV_FILE="$APP_DIR/.env"
REDIS_URL_VALUE=""
if [ "$FF_INSTALL_REDIS" = "1" ]; then
    REDIS_URL_VALUE="redis://127.0.0.1:6379"
fi
log_info "写入环境变量配置..."
if [ -e "$ENV_FILE" ]; then
    log_error "检测到现有 .env。为避免覆盖生产密钥和数据库凭据，安装程序已停止。"
    log_error "请备份并人工迁移现有配置后再进行首次初始化。"
    exit 1
fi

cat > "$ENV_FILE" << EOF
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=$DEFAULT_DB_NAME
DB_USER=foodflow
DB_PASSWORD=$DB_RANDOM_PASSWORD
DB_CONNECTION_LIMIT=50
REDIS_URL=$REDIS_URL_VALUE
UPLOAD_DIR=$APP_DIR/uploads
RUN_SCHEDULED_TASKS=false
JWT_SECRET=$JWT_RANDOM_SECRET
QR_DOMAIN=
EOF

chmod 600 "$ENV_FILE"
log_success ".env 配置文件已生成"

echo "  数据库配置:"
echo "    主机: 127.0.0.1"
echo "    数据库: $DEFAULT_DB_NAME"
echo "    用户: foodflow"
echo "    密码: ${DB_RANDOM_PASSWORD:0:4}****（完整密码见 .env 文件）"


# ===== 7.8 生产优化 =====
apply_production_optimizations() {
    log_info "应用生产环境优化..."
    [ -f "$APP_DIR/server/config/env.js" ] && grep -q 'DB_CONNECTION_LIMIT' "$APP_DIR/server/config/env.js" ||       sed -i 's|\(DB_PORT: Number(process.env.DB_PORT) || 3306,\)|
  DB_CONNECTION_LIMIT: Number(process.env.DB_CONNECTION_LIMIT) || 50,|' "$APP_DIR/server/config/env.js" 2>/dev/null || true
    [ -f "$APP_DIR/server/db/pool.js" ] && sed -i -E 's|connectionLimit:\s*[0-9]+|connectionLimit: env.DB_CONNECTION_LIMIT|;s|queueLimit:\s*[0-9]+|queueLimit: 200|' "$APP_DIR/server/db/pool.js"
    MC=""
    mariadb -u root -e "SELECT 1" >/dev/null 2>&1 && MC="mariadb -u root"
    [ -z "$MC" ] && mysql -u root -e "SELECT 1" >/dev/null 2>&1 && MC="mysql -u root"
    if [ -n "$MC" ]; then
      for idx in \
        "orders idx_store_status_created (store_id, status, createdAt)" \
        "orders idx_store_table_status (store_id, table_name, status)" \
        "orders idx_store_created (store_id, createdAt)" \
        "waiter_calls idx_store_status_created (store_id, status, created_at)" \
        "scan_sessions idx_store_expires (store_id, expires_at)" \
        "menus idx_store_active (store_id, active)" \
        "tables idx_store_status (store_id, status)"; do
        set -- $idx; TBL=$1; NAME=$2; shift 2
        EX=$($MC "$DEFAULT_DB_NAME" -N -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA='$DEFAULT_DB_NAME' AND TABLE_NAME='$TBL' AND INDEX_NAME='$NAME';" 2>/dev/null)
        [ "${EX:-0}" -lt 1 ] && $MC "$DEFAULT_DB_NAME" -e "CREATE INDEX $NAME ON \`$TBL\` $*;" 2>/dev/null || true
      done
    fi
    log_success "生产环境优化完成"
}
apply_production_optimizations

# ===== 8. 停止旧服务，配置 Systemd =====
echo ""
log_info "配置 Systemd 服务..."

# 先停止并禁用旧服务（避免不断重启）
systemctl stop foodflow 2>/dev/null || true
systemctl disable foodflow 2>/dev/null || true
sleep 1

ff_require_port_available 3000

NODE_PATH=$(which node)
if ! id foodflow >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin --gid www-data foodflow
fi
mkdir -p /var/lib/foodflow
chown foodflow:www-data /var/lib/foodflow
chmod 0700 /var/lib/foodflow
chown -R root:www-data "$APP_DIR"
for writable_dir in uploads backups logs; do
    mkdir -p "$APP_DIR/$writable_dir"
    chown -R foodflow:www-data "$APP_DIR/$writable_dir"
    chmod 0770 "$APP_DIR/$writable_dir"
done
chown root:www-data "$ENV_FILE"
chmod 0640 "$ENV_FILE"

cat > /etc/systemd/system/$SERVICE_NAME.service << EOF
[Unit]
Description=FoodFlow QR Ordering System
After=network.target mariadb.service mysql.service

[Service]
Type=simple
User=foodflow
Group=www-data
WorkingDirectory=$APP_DIR
ExecStart=$NODE_PATH server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable foodflow
log_success "Systemd 服务配置完成"

# ===== 9. 配置 Nginx =====
echo ""
log_info "配置 Nginx..."
cat > /etc/nginx/conf.d/foodflow.conf << EOF
server {
    listen 80;
    server_name _;

    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_read_timeout 86400;
    }

    location /uploads/ {
        alias $APP_DIR/uploads/;
        expires 30d;
    }
}
EOF

# 测试并重载 Nginx
if nginx -t 2>/dev/null; then
    systemctl reload nginx
    log_success "Nginx 配置完成"
else
    log_warn "Nginx 配置测试失败，请手动检查 /etc/nginx/conf.d/foodflow.conf"
fi

# ===== 10. 启动服务 =====
echo ""
log_info "启动 FoodFlow 服务..."

systemctl restart foodflow || true
sleep 8

# 检查服务状态
if systemctl is-active --quiet foodflow; then
    log_success "FoodFlow 服务启动成功！"
else
    log_error "服务启动失败，最近日志："
    journalctl -u foodflow -n 40 --no-pager
    echo ""
    log_error "应用日志目录: $APP_DIR/logs/"
    exit 1
fi

# ===== 11. 最小首次运行检查 =====
echo ""
log_info "检查配置、服务、数据库和首次登录凭据..."
bash "$APP_DIR/scripts/first-run-check.sh" "$APP_DIR"

# 检查 Nginx
NGINX_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://127.0.0.1/ 2>/dev/null || echo "000")
if [ "$NGINX_CODE" = "200" ] || [ "$NGINX_CODE" = "302" ]; then
    log_success "Nginx 代理正常 (HTTP $NGINX_CODE)"
else
    log_warn "Nginx 代理状态: HTTP $NGINX_CODE"
fi


# ===== 可选：防火墙（默认不自动启用，避免误锁远程 SSH） =====
if [ "$FF_CONFIGURE_UFW" = "1" ]; then
    log_info "按 FF_CONFIGURE_UFW=1 配置 UFW..."
    if ! command -v ufw >/dev/null 2>&1; then ff_apt_install ufw; fi
    ufw allow OpenSSH
    ufw allow 80/tcp
    ufw allow 443/tcp
    log_warn "UFW 规则已添加，但安装器不会自动启用防火墙；请确认 SSH 端口后手动执行 ufw enable。"
else
    log_info "跳过 UFW 自动配置；请按服务器实际 SSH 端口和防火墙策略手动配置。"
fi

# ===== 可选：自动备份（默认不创建含数据库凭据的 cron 脚本） =====
if [ "$FF_CONFIGURE_BACKUP_CRON" = "1" ]; then
    log_info "FF_CONFIGURE_BACKUP_CRON=1 已启用；数据库凭据单独保存在 root-only 配置文件中。"
    install -d -o root -g root -m 0700 "$CONFIG_DIR"
    BACKUP_OLD_UMASK="$(umask)"
    umask 077
    printf '[client]\nhost=127.0.0.1\nuser=foodflow\npassword="%s"\n' "$DB_RANDOM_PASSWORD" > "$CONFIG_DIR/backup.cnf"
    umask "$BACKUP_OLD_UMASK"
    chown root:root "$CONFIG_DIR/backup.cnf"
    chmod 0600 "$CONFIG_DIR/backup.cnf"
    install -d -o root -g root -m 0755 /usr/local/sbin
    BACKUP_SCRIPT="/usr/local/sbin/foodflow-auto-backup"
    cat > "$BACKUP_SCRIPT" << 'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
DATE="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="__BACKUP_DIR__"
DB_NAME="__DB_NAME__"
mkdir -p "$BACKUP_DIR"
TMP_FILE="$(mktemp "$BACKUP_DIR/.db_$DATE.XXXXXX")"
trap 'rm -f "$TMP_FILE" "$TMP_FILE.gz"' EXIT
mysqldump --defaults-extra-file=/etc/foodflow/backup.cnf --single-transaction --quick "$DB_NAME" > "$TMP_FILE"
gzip "$TMP_FILE"
mv "$TMP_FILE.gz" "$BACKUP_DIR/db_$DATE.sql.gz"
find "$BACKUP_DIR" -name "db_*.sql.gz" -mtime +7 -delete
EOF
    sed -i "s|__BACKUP_DIR__|$APP_DIR/backups|g; s|__DB_NAME__|$DEFAULT_DB_NAME|g" "$BACKUP_SCRIPT"
    chown root:root "$BACKUP_SCRIPT"
    chmod 0700 "$BACKUP_SCRIPT"
else
    log_info "跳过自动备份计划任务；首次安装完成后请尽快配置独立备份策略。"
fi

# ===== 14. 配置日志轮转 =====
echo ""
log_info "配置日志轮转..."
cat > /etc/logrotate.d/foodflow << EOF
$APP_DIR/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0644 root root
    postrotate
        systemctl reload foodflow 2>/dev/null || true
    endscript
}
EOF
log_success "日志轮转已配置（保留14天）"

# ===== 完成 =====
echo ""
echo "=========================================="
echo -e "${GREEN}  安装完成！${NC}"
echo "=========================================="
echo ""
echo "应用目录:   $APP_DIR"
echo "环境变量:   $ENV_FILE"
echo "日志目录:   $APP_DIR/logs/"
echo "上传目录:   $APP_DIR/uploads/"
echo "备份目录:   $APP_DIR/backups/"
echo ""
echo "服务管理命令:"
echo "  启动: sudo systemctl start foodflow"
echo "  停止: sudo systemctl stop foodflow"
echo "  重启: sudo systemctl restart foodflow"
echo "  状态: sudo systemctl status foodflow"
echo "  日志: sudo journalctl -u foodflow -f"
echo "  应用日志: tail -f $APP_DIR/logs/server.log"
echo ""
echo "访问地址:"
echo "  本地: http://127.0.0.1"
echo "  外网: http://$(hostname -I | awk '{print $1}')"
echo ""
echo "初始账号用户名：superadmin / admin / waiter"
echo "初始密码：系统随机生成，见 /var/lib/foodflow/initial-credentials.txt"
echo ""
log_warn "重要提示："
echo "  1. 数据库已自动配置，密码保存在 $ENV_FILE（权限600）"
echo "  2. 首次登录后请立即修改所有初始密码"
echo "  3. 建议配置 SSL 证书: sudo bash setup-nginx.sh"
echo "  4. 服务日志: sudo journalctl -u foodflow -f"
echo ""
