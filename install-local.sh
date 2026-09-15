#!/bin/bash
# ============================================================
# FoodFlow 本地一键安装脚本（无需拉取代码）
# 适用场景：代码已在当前目录，直接安装部署
#
# 使用方法：
#   cd /path/to/foodflow
#   sudo bash install-local.sh
#
# 支持系统：Debian 11+ / Ubuntu 20.04+
# ============================================================

set -e

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

# ===== 检查 root 权限 =====
if [ "$EUID" -ne 0 ]; then
    log_error "请使用 root 权限运行：sudo bash $0"
    exit 1
fi

# ===== 获取当前目录 =====
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log_info "应用目录: $APP_DIR"

# ===== 检查核心文件 =====
if [ ! -f "$APP_DIR/server.js" ]; then
    log_error "当前目录未找到 server.js，请确认在项目根目录下运行"
    exit 1
fi

if [ ! -f "$APP_DIR/package.json" ]; then
    log_error "当前目录未找到 package.json，请确认在项目根目录下运行"
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
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget git nginx build-essential
log_success "系统软件包更新完成"

# ===== 2. 安装 MariaDB =====
echo ""
log_info "检查数据库..."
DB_INSTALLED=false
if command -v mariadb &> /dev/null || command -v mysql &> /dev/null; then
    DB_INSTALLED=true
    log_success "MariaDB/MySQL 已安装"
else
    log_info "安装 MariaDB（兼容MySQL）..."
    apt-get install -y -qq mariadb-server
    systemctl enable mariadb
    systemctl start mariadb
    log_success "MariaDB 安装完成"
fi

# 确保数据库服务运行
systemctl start mariadb 2>/dev/null || systemctl start mysql 2>/dev/null || true

# ===== 3. 安装 Redis =====
echo ""
log_info "检查 Redis..."
if command -v redis-server &> /dev/null; then
    log_success "Redis 已安装"
else
    log_info "安装 Redis..."
    apt-get install -y -qq redis-server
    systemctl enable redis-server
    systemctl start redis
    log_success "Redis 安装完成"
fi
systemctl start redis-server 2>/dev/null || true

# ===== 4. 安装 Node.js 20 LTS =====
echo ""
log_info "检查 Node.js..."
NODE_VERSION=0
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v 2>/dev/null | cut -d. -f1 | tr -d 'v' || echo 0)
fi

if [ "$NODE_VERSION" -lt 18 ]; then
    log_info "安装 Node.js 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
    log_success "Node.js 安装完成: $(node -v)"
else
    log_success "Node.js 已安装: $(node -v)"
fi

# ===== 5. 安装 npm 依赖 =====
echo ""
log_info "安装 Node.js 依赖..."
cd "$APP_DIR"
npm install --production --no-audit --no-fund
log_success "依赖安装完成"

# ===== 6. 创建必要目录 =====
echo ""
log_info "创建必要目录..."
mkdir -p "$APP_DIR"/{uploads,backups,logs}
mkdir -p /etc/foodflow
log_success "目录创建完成"

# ===== 7. 配置环境变量 =====
echo ""
log_info "配置环境变量..."
ENV_FILE="$APP_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$APP_DIR/.env.example" ]; then
        cp "$APP_DIR/.env.example" "$ENV_FILE"
        log_warn "已从 .env.example 创建 .env 文件"
    else
        # 创建默认 .env
        cat > "$ENV_FILE" << 'EOF'
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=foodflow
DB_USER=root
DB_PASSWORD=
DB_CONNECTION_LIMIT=50
REDIS_URL=
UPLOAD_DIR=./uploads
RUN_SCHEDULED_TASKS=true
JWT_SECRET=please-change-this-secret-key
QR_DOMAIN=
EOF
        log_warn "已创建默认 .env 文件"
    fi
else
    log_success ".env 文件已存在"
fi

chmod 600 "$ENV_FILE"

# 生成随机 JWT_SECRET（如果是默认值）
if grep -q "please-change-this-secret-key" "$ENV_FILE"; then
    RANDOM_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)
    sed -i "s/please-change-this-secret-key/$RANDOM_SECRET/" "$ENV_FILE"
    log_success "已生成随机 JWT_SECRET"
fi

# 显示数据库配置（不显示密码）
echo "  当前数据库配置:"
echo "    主机: $(grep '^DB_HOST=' "$ENV_FILE" | cut -d= -f2)"
echo "    数据库: $(grep '^DB_NAME=' "$ENV_FILE" | cut -d= -f2)"
echo "    用户: $(grep '^DB_USER=' "$ENV_FILE" | cut -d= -f2)"

# ===== 8. 创建数据库（如果需要） =====
echo ""
log_info "检查数据库..."
DB_NAME=$(grep '^DB_NAME=' "$ENV_FILE" | cut -d= -f2)
DB_USER=$(grep '^DB_USER=' "$ENV_FILE" | cut -d= -f2)
DB_PASSWORD=$(grep '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2)

# 尝试连接数据库并创建
if [ -z "$DB_PASSWORD" ]; then
    # 无密码，尝试 root 无密码连接
    if mariadb -u root -e "USE $DB_NAME;" 2>/dev/null || mysql -u root -e "USE $DB_NAME;" 2>/dev/null; then
        log_success "数据库 $DB_NAME 已存在"
    else
        log_info "创建数据库 $DB_NAME..."
        mariadb -u root -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null || \
        mysql -u root -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null || \
        log_warn "自动创建数据库失败，请手动创建"
        log_success "数据库 $DB_NAME 创建完成"
    fi
else
    log_info "数据库密码已配置，跳过自动创建（请确保数据库已存在）"
fi

# ===== 9. 配置 Systemd 服务 =====
echo ""
log_info "配置 Systemd 服务..."
NODE_PATH=$(which node)

cat > /etc/systemd/system/foodflow.service << EOF
[Unit]
Description=FoodFlow QR Ordering System
After=network.target mariadb.service mysql.service redis.service
Wants=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=$NODE_PATH server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=$ENV_FILE
LimitNOFILE=65536
StandardOutput=append:$APP_DIR/logs/server.log
StandardError=append:$APP_DIR/logs/server-error.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable foodflow
log_success "Systemd 服务配置完成"

# ===== 10. 配置 Nginx =====
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

# ===== 11. 启动服务 =====
echo ""
log_info "启动 FoodFlow 服务..."

# 先杀掉可能占用3000端口的进程
fuser -k 3000/tcp 2>/dev/null || true
sleep 1

systemctl restart foodflow
sleep 5

# 检查服务状态
if systemctl is-active --quiet foodflow; then
    log_success "FoodFlow 服务启动成功！"
else
    log_error "服务启动失败，查看日志："
    journalctl -u foodflow -n 30 --no-pager
    echo ""
    log_error "也可以查看应用日志：tail -50 $APP_DIR/logs/server.log"
    exit 1
fi

# ===== 12. 健康检查 =====
echo ""
log_info "执行健康检查..."
sleep 2

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://127.0.0.1:3000/ 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "304" ]; then
    log_success "应用响应正常 (HTTP $HTTP_CODE)"
else
    log_warn "应用响应状态: HTTP $HTTP_CODE（可能需要等待初始化）"
fi

# 检查 Nginx
NGINX_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://127.0.0.1/ 2>/dev/null || echo "000")
if [ "$NGINX_CODE" = "200" ] || [ "$NGINX_CODE" = "302" ]; then
    log_success "Nginx 代理正常 (HTTP $NGINX_CODE)"
else
    log_warn "Nginx 代理状态: HTTP $NGINX_CODE"
fi

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
echo "默认账号:"
echo "  超级管理员: superadmin / super123"
echo "  商户管理员: admin / admin123"
echo ""
log_warn "重要提示："
echo "  1. 请编辑 $ENV_FILE 配置正确的数据库密码"
echo "  2. 请及时修改默认管理员密码"
echo "  3. 建议配置 SSL 证书: sudo apt-get install certbot python3-certbot-nginx && sudo certbot --nginx"
echo "  4. 如数据库连接失败，请检查 .env 中的数据库配置并手动创建数据库"
echo ""
