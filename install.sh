#!/bin/bash
# ============================================================
# FoodFlow 点餐系统 - 一键安装脚本
# 支持：单台部署 / 2台服务器部署 / 多台服务器集群部署
# 用法：sudo bash install.sh
# ============================================================

set -e

# 设置非交互模式，避免 apt 安装时弹出键盘布局等交互界面
export DEBIAN_FRONTEND=noninteractive

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# 日志函数
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }
log_success() { echo -e "${GREEN}${BOLD}[SUCCESS]${NC}${NC} $1"; }

# 脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR/deploy"

# ===== 全局配置（安装前只需要改这里）=====
# 路径配置
APP_DIR="/var/www/foodflow"          # 应用安装目录
CONFIG_DIR="/etc/foodflow"           # 配置文件目录
SERVICE_NAME="foodflow"              # systemd 服务名

# 版本选择（main = 最新开发版，或者填 tag 版本号比如 v1.0.0）
GIT_VERSION="main"                       # 要安装的 git 版本（main 或 tag）

# 域名和邮箱（用于 SSL 证书，留空则不配置 HTTPS）
DOMAIN="foodflow.v2net.cc"           # 你的域名，比如 foodflow.example.com
EMAIL="v2wallid@gmail.com"               # 你的邮箱，用于证书续期提醒

# ============================================================
# 显示横幅
# ============================================================
show_banner() {
    clear 2>/dev/null || true
    echo -e "${PURPLE}${BOLD}"
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║                                                              ║"
    echo "║   ███████╗ ██████╗  ██████╗ ██████╗ ███████╗██╗      ██╗   ██╗║"
    echo "║   ██╔════╝██╔═══██╗██╔═══██╗██╔══██╗██╔════╝██║      ██║   ██║║"
    echo "║   █████╗  ██║   ██║██║   ██║██║  ██║█████╗  ██║█████╗██║   ██║║"
    echo "║   ██╔══╝  ██║   ██║██║   ██║██║  ██║██╔══╝  ██║╚════╝╚██╗ ██╔╝║"
    echo "║   ██║     ╚██████╔╝╚██████╔╝██████╔╝██║     ██║       ╚████╔╝ ║"
    echo "║   ╚═╝      ╚═════╝  ╚═════╝ ╚═════╝ ╚═╝     ╚═╝        ╚═══╝  ║"
    echo "║                                                              ║"
    echo "║            多语言扫码点餐系统 - 一键安装向导                 ║"
    echo "║                                                              ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
}

# ============================================================
# 检查root权限
# ============================================================
check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "请使用 root 用户运行此脚本：sudo bash install.sh"
        exit 1
    fi
}

# ============================================================
# 检查系统
# ============================================================
check_system() {
    log_step "检查系统环境..."

    # 检查操作系统
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_NAME="$NAME"
        OS_VERSION="$GIT_VERSION_ID"
        log_info "操作系统：$OS_NAME $OS_VERSION"
    else
        log_error "无法识别操作系统，支持 Debian 11+ / Ubuntu 20.04+"
        exit 1
    fi

    # 检查是否为Debian/Ubuntu系
    if [ "$ID" != "debian" ] && [ "$ID" != "ubuntu" ]; then
        log_warn "当前系统为 $OS_NAME，建议使用 Debian 11+ 或 Ubuntu 20.04+"
        read -p "是否继续安装？(y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "安装已取消"
            exit 0
        fi
    fi

    # 检查架构
    ARCH=$(uname -m)
    log_info "系统架构：$ARCH"

    # 检查内存
    MEM_TOTAL=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || echo "未知")
    log_info "内存总量：${MEM_TOTAL}MB"

    # 检查磁盘
    DISK_TOTAL=$(df -h / | awk 'NR==2{print $2}')
    log_info "磁盘总量：$DISK_TOTAL"

    echo ""
}

# ============================================================
# 部署模式选择菜单
# ============================================================
select_deploy_mode() {
    # 命令行参数预选：bash install.sh [standard|enterprise|enterprise-ultimate]
    if [ -n "$1" ]; then
        case "$1" in
            standard) DEPLOY_MODE="standard"; DEPLOY_NAME="标准版 - 单台部署"; return ;;
            enterprise) DEPLOY_MODE="enterprise"; DEPLOY_NAME="企业版 - 2台服务器部署"; return ;;
            enterprise-ultimate) DEPLOY_MODE="enterprise-ultimate"; DEPLOY_NAME="企业旗舰版 - 多台服务器集群部署"; return ;;
            *) log_error "未知部署模式：$1（可选 standard/enterprise/enterprise-ultimate）"; exit 1 ;;
        esac
    fi

    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}${BOLD}  请选择部署模式：${NC}"
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${BOLD}1. 标准版 - 单台部署${NC}"
    echo "     所有服务（Nginx + Node.js + MariaDB + Redis）在一台服务器"
    echo "     适用：1-50家门店，测试环境，小型餐饮企业"
    echo "     配置要求：2核4GB以上"
    echo ""
    echo -e "  ${BOLD}2. 企业版 - 2台服务器部署${NC}"
    echo "     双机负载均衡 + 共享数据库/Redis/NFS"
    echo "     适用：100-200家门店，中型餐饮连锁"
    echo "     配置要求：2台4核8GB应用服务器 + 独立MySQL/Redis"
    echo ""
    echo -e "  ${BOLD}3. 企业旗舰版 - 多台服务器集群部署${NC}"
    echo "     多节点负载均衡，可水平扩展，支持多商户/SaaS"
    echo "     适用：200+家门店，大型餐饮集团，SaaS平台"
    echo "     配置要求：3台以上8核16GB应用服务器 + 高可用MySQL/Redis"
    echo ""
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""

    while true; do
        read -p "请输入选项 (1/2/3): " -n 1 -r
        echo
        case $REPLY in
            1)
                DEPLOY_MODE="standard"
                DEPLOY_NAME="标准版 - 单台部署"
                break
                ;;
            2)
                DEPLOY_MODE="enterprise"
                DEPLOY_NAME="企业版 - 2台服务器部署"
                break
                ;;
            3)
                DEPLOY_MODE="enterprise-ultimate"
                DEPLOY_NAME="企业旗舰版 - 多台服务器集群部署"
                break
                ;;
            *)
                log_warn "无效选项，请输入 1、2 或 3"
                ;;
        esac
    done

    echo ""
    log_info "已选择：${BOLD}$DEPLOY_NAME${NC}"
    echo ""
}

# ============================================================
# 节点角色选择（集群部署）
# ============================================================
select_node_role() {
    if [ "$DEPLOY_MODE" == "standard" ]; then
        NODE_ROLE="single"
        return
    fi

    # 命令行参数预选第二参数：bash install.sh enterprise [master|slave]
    if [ -n "$2" ]; then
        case "$2" in
            master|slave) NODE_ROLE="$2"; return ;;
            *) log_error "未知节点角色：$2（可选 master/slave）"; exit 1 ;;
        esac
    fi

    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}${BOLD}  请选择当前服务器的角色：${NC}"
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${BOLD}1. 主节点 (Master)${NC}"
    echo "     执行定时任务（自动备份、日志清理）"
    echo "     第一台应用服务器选择此项"
    echo ""
    echo -e "  ${BOLD}2. 从节点 (Slave)${NC}"
    echo "     不执行定时任务，只处理业务请求"
    echo "     第二台及后续应用服务器选择此项"
    echo ""
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""

    while true; do
        read -p "请输入选项 (1/2): " -n 1 -r
        echo
        case $REPLY in
            1)
                NODE_ROLE="master"
                break
                ;;
            2)
                NODE_ROLE="slave"
                break
                ;;
            *)
                log_warn "无效选项，请输入 1 或 2"
                ;;
        esac
    done

    echo ""
    log_info "节点角色：${BOLD}$NODE_ROLE${NC}"
    echo ""
}

# ============================================================
# 确认安装配置
# ============================================================
confirm_installation() {
    echo -e "${YELLOW}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}${BOLD}  安装配置确认：${NC}"
    echo -e "${YELLOW}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  部署模式：$DEPLOY_NAME"
    if [ "$DEPLOY_MODE" != "standard" ]; then
        echo "  节点角色：$NODE_ROLE"
    fi
    echo "  操作系统：$OS_NAME $OS_VERSION"
    echo "  系统架构：$ARCH"
    echo "  内存总量：${MEM_TOTAL}MB"
    echo "  磁盘总量：$DISK_TOTAL"
    echo ""
    echo -e "${YELLOW}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""

    read -p "确认开始安装？(y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "安装已取消"
        exit 0
    fi
    echo ""
}

# ============================================================
# 单台部署
# ============================================================
install_single() {
    log_step "开始单台部署..."

    DEPLOY_TARGET="$APP_DIR"
    log_info "部署目标目录: $DEPLOY_TARGET"

    # ===== 1. 安装基础工具 =====
    log_info "安装基础工具..."
    apt-get update -qq
    apt-get install -y -qq curl wget git rsync
    log_success "基础工具安装完成"

    # ===== 2. 部署代码到 $APP_DIR =====
    echo ""
    log_info "部署代码到 $DEPLOY_TARGET..."

    # 创建目标目录
    mkdir -p "$DEPLOY_TARGET"

    if [ -d "$SCRIPT_DIR/.git" ]; then
        # 当前目录有 git：用 rsync 同步代码（排除 .git、node_modules 等）
        log_info "从当前目录同步代码..."
        rsync -a --delete \
            --exclude '.git' \
            --exclude 'node_modules' \
            --exclude 'uploads/*' \
            --exclude 'backups/*' \
            --exclude 'logs/*' \
            --exclude '.env' \
            "$SCRIPT_DIR/" "$DEPLOY_TARGET/"
        log_success "代码同步完成"
    elif [ -d "$DEPLOY_TARGET/.git" ]; then
        # 已部署过：git pull 更新
        log_info "检测到已部署，执行 git pull 更新..."
        cd "$DEPLOY_TARGET"
        # 如果有 GITHUB_TOKEN，用带 token 的地址 pull
        if [ -n "$GITHUB_TOKEN" ]; then
            git pull "https://${GITHUB_TOKEN}@github.com/Tony855/shaolafang.git" main || log_warn "git pull 失败，继续使用现有代码"
        else
            git pull origin main || log_warn "git pull 失败，继续使用现有代码"
        fi
        log_success "代码更新完成"
    elif [ -f "$SCRIPT_DIR/server.js" ]; then
        # 当前目录有代码（但不是 git）：直接复制
        log_info "复制代码到 $DEPLOY_TARGET..."
        cp -r "$SCRIPT_DIR"/* "$DEPLOY_TARGET/" 2>/dev/null || true
        log_success "代码复制完成"
    else
        # 当前目录没有代码：自动从 GitHub 克隆
        log_info "当前目录未找到代码，自动从 GitHub 克隆..."
        
        # 如果目标目录已经存在且不为空，先备份
        if [ -d "$DEPLOY_TARGET" ] && [ "$(ls -A "$DEPLOY_TARGET" 2>/dev/null)" ]; then
            BACKUP_DIR="$DEPLOY_TARGET.backup.$(date +%Y%m%d%H%M%S)"
            log_warn "目标目录已存在，备份到 $BACKUP_DIR"
            mv "$DEPLOY_TARGET" "$BACKUP_DIR"
        fi
        
        mkdir -p "$DEPLOY_TARGET"
        
        # 自动把 GitHub 加到 known_hosts，避免首次连接确认提示
        mkdir -p ~/.ssh
        ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null

        # 克隆代码：优先 SSH，其次 HTTPS + TOKEN，最后 HTTPS 匿名
        if git ls-remote git@github.com:Tony855/shaolafang.git HEAD >/dev/null 2>&1; then
            log_info "使用 SSH 方式克隆..."
            git clone --branch "$GIT_VERSION" git@github.com:Tony855/shaolafang.git "$DEPLOY_TARGET"
        elif [ -n "$GITHUB_TOKEN" ]; then
            log_info "使用 HTTPS + GITHUB_TOKEN 方式克隆..."
            git clone --branch "$GIT_VERSION" "https://${GITHUB_TOKEN}@github.com/Tony855/shaolafang.git" "$DEPLOY_TARGET"
            # 克隆完立刻剥离 token，防止写入 .git/config
            cd "$DEPLOY_TARGET"
            git remote set-url origin https://github.com/Tony855/shaolafang.git
            git config --unset credential.helper 2>/dev/null || true
        else
            log_info "使用 HTTPS 方式克隆（需要输入用户名密码）..."
            git clone --branch "$GIT_VERSION" https://github.com/Tony855/shaolafang.git "$DEPLOY_TARGET"
        fi
        
        if [ $? -ne 0 ]; then
            log_error "代码克隆失败，请手动上传代码到 $DEPLOY_TARGET"
            exit 1
        fi
        log_success "代码克隆完成"
    fi

    # 创建必要的子目录
    mkdir -p "$DEPLOY_TARGET"/{uploads,backups,logs}

    cd "$DEPLOY_TARGET"
    APP_DIR="$DEPLOY_TARGET"

    # ===== 3. 安装系统依赖 =====
    echo ""
    log_info "更新系统软件包..."
    apt-get update -qq
    apt-get upgrade -y -qq
    apt-get install -y -qq curl wget git nginx build-essential rsync certbot python3-certbot-nginx dnsutils psmisc ufw
    log_success "系统软件包更新完成"

    # ===== 4. 安装 MariaDB =====
    echo ""
    log_info "检查数据库..."
    if command -v mariadb &> /dev/null || command -v mysql &> /dev/null; then
        log_success "MariaDB/MySQL 已安装"
    else
        log_info "安装 MariaDB..."
        apt-get install -y -qq mariadb-server
        systemctl enable mariadb
        systemctl start mariadb
        log_success "MariaDB 安装完成"
    fi
    systemctl start mariadb 2>/dev/null || systemctl start mysql 2>/dev/null || true

    # ===== 5. 安装 Redis =====
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

# ===== 3.1 开启 Redis AOF 持久化（避免重启后订单号计数器回退） =====
if [ -f /etc/redis/redis.conf ]; then
    if grep -q '^appendonly no' /etc/redis/redis.conf; then
        sed -i 's/^appendonly no/appendonly yes/' /etc/redis/redis.conf
        log_info "Redis AOF 已开启（appendonly yes）"
    elif ! grep -q '^appendonly yes' /etc/redis/redis.conf; then
        echo 'appendonly yes' >> /etc/redis/redis.conf
        log_info "Redis AOF 已开启（追加配置）"
    fi
    grep -q '^appendfsync' /etc/redis/redis.conf || echo 'appendfsync everysec' >> /etc/redis/redis.conf
    systemctl restart redis-server 2>/dev/null || systemctl restart redis 2>/dev/null || true
fi


    # ===== 6. 安装 Node.js 20 LTS =====
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

    # ===== 7. 安装 npm 依赖 =====
    echo ""
    log_info "安装 Node.js 依赖..."
    npm install --omit=dev --no-audit --no-fund
    log_success "依赖安装完成"

    # ===== 8. 创建必要目录 =====
    echo ""
    log_info "创建必要目录..."
    mkdir -p "$APP_DIR"/{uploads,backups,logs}
    mkdir -p "$CONFIG_DIR"
    chown -R root:www-data "$APP_DIR"
    chmod -R 755 "$APP_DIR"
    chmod -R 775 "$APP_DIR/uploads"
    log_success "目录创建完成，权限已配置"

    # ===== 9. 配置数据库 =====
    echo ""
    # 检查是否已安装过：如果 .env 存在，说明是更新模式，跳过数据库重建
    if [ -f "$CONFIG_DIR/.env" ]; then
        log_info "检测到已安装（.env 存在），跳过数据库重建，保留所有数据！"
        SKIP_DB_INIT=1
    else
        log_info "自动配置数据库（首次安装）..."
        SKIP_DB_INIT=0
    fi
    DEFAULT_DB_NAME="foodflow_system"
    log_info "数据库名: $DEFAULT_DB_NAME"

    DB_RANDOM_PASSWORD=$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 16)
    JWT_RANDOM_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)

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

    if [ "$SKIP_DB_INIT" -eq 0 ]; then
    log_info "创建数据库..."
    $MYSQL_CMD -e "DROP DATABASE IF EXISTS \`$DEFAULT_DB_NAME\`;"
    $MYSQL_CMD -e "CREATE DATABASE \`$DEFAULT_DB_NAME\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

    log_info "创建数据库用户..."
    $MYSQL_CMD -e "DROP USER IF EXISTS 'foodflow'@'localhost';"
    $MYSQL_CMD -e "DROP USER IF EXISTS 'foodflow'@'127.0.0.1';"
    $MYSQL_CMD -e "CREATE USER 'foodflow'@'localhost' IDENTIFIED BY '$DB_RANDOM_PASSWORD';"
    $MYSQL_CMD -e "CREATE USER 'foodflow'@'127.0.0.1' IDENTIFIED BY '$DB_RANDOM_PASSWORD';"
    $MYSQL_CMD -e "GRANT ALL PRIVILEGES ON \`$DEFAULT_DB_NAME\`.* TO 'foodflow'@'localhost';"
    $MYSQL_CMD -e "GRANT ALL PRIVILEGES ON \`$DEFAULT_DB_NAME\`.* TO 'foodflow'@'127.0.0.1';"
    $MYSQL_CMD -e "FLUSH PRIVILEGES;"
    else
        log_info "跳过数据库用户创建（已存在）"
    fi

    log_info "验证数据库连接..."
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

    if timeout 10 node db-test.js; then
        log_success "数据库和用户创建成功，连接测试通过"
    else
        log_error "数据库连接测试失败，请检查 MariaDB 配置"
        rm -f "$APP_DIR/db-test.js"
        exit 1
    fi
    rm -f "$APP_DIR/db-test.js"

    # ===== 10. 写入 .env 配置文件 =====
    echo ""
    log_info "写入环境变量配置..."
    ENV_FILE="$APP_DIR/.env"
    cat > "$ENV_FILE" << EOF
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=$DEFAULT_DB_NAME
DB_USER=foodflow
DB_PASSWORD=$DB_RANDOM_PASSWORD
DB_CONNECTION_LIMIT=50
REDIS_URL=redis://127.0.0.1:6379
UPLOAD_DIR=$APP_DIR/uploads
RUN_SCHEDULED_TASKS=true
JWT_SECRET=$JWT_RANDOM_SECRET
QR_DOMAIN=$DOMAIN
EOF
    chmod 600 "$ENV_FILE"
    log_success ".env 配置文件已生成"

    # ===== 11. 配置 Systemd 服务 =====
    echo ""
    log_info "配置 Systemd 服务..."
    systemctl stop $SERVICE_NAME 2>/dev/null || true
    systemctl disable $SERVICE_NAME 2>/dev/null || true
    sleep 1
    fuser -k 3000/tcp 2>/dev/null || true
    sleep 1

    NODE_PATH=$(which node)
    cat > /etc/systemd/system/$SERVICE_NAME.service << EOF
[Unit]
Description=FoodFlow QR Ordering System
After=network.target mariadb.service mysql.service redis.service

[Service]
Type=simple
User=root
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
    systemctl enable $SERVICE_NAME
    log_success "Systemd 服务配置完成"

    # ===== 12. 配置 Nginx 和 SSL =====
    echo ""
    log_info "配置 Nginx 反向代理和 SSL..."
    
    # 删除 Nginx 默认站点，避免冲突
    rm -f /etc/nginx/sites-enabled/default

    if [ -f "$APP_DIR/setup-nginx.sh" ]; then
        DOMAIN="$DOMAIN" EMAIL="$EMAIL" bash setup-nginx.sh || log_warn "Nginx 配置失败"
    else
        log_warn "未找到 setup-nginx.sh，使用基础 Nginx 配置"
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
    }
    location /uploads/ {
        alias $APP_DIR/uploads/;
        expires 30d;
    }
}
EOF
        nginx -t && systemctl reload nginx
    fi

    # ===== 13. 启动服务 =====
    echo ""
    log_info "启动 FoodFlow 服务..."
    systemctl restart $SERVICE_NAME || true
    sleep 8

    if systemctl is-active --quiet $SERVICE_NAME; then
        log_success "FoodFlow 服务启动成功！"
    else
        log_error "服务启动失败，最近日志："
        journalctl -u $SERVICE_NAME -n 40 --no-pager
        exit 1
    fi

    # ===== 14. 健康检查 =====
    echo ""
    log_info "执行健康检查..."
    sleep 2
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://127.0.0.1:3000/ 2>/dev/null || echo "000")
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ]; then
        log_success "应用响应正常 (HTTP $HTTP_CODE)"
    else
        log_warn "应用响应状态: HTTP $HTTP_CODE"
    fi

    # ===== 15. 防火墙提示（不自动启用，避免把自己锁在外面）=====
    echo ""
    log_warn "如果需要配置防火墙，请手动执行："
    echo "  sudo ufw allow OpenSSH"
    echo "  sudo ufw allow 80/tcp"
    echo "  sudo ufw allow 443/tcp"
    echo "  sudo ufw enable"
    log_info "防火墙未自动启用，避免误锁 SSH 连接"

    echo ""
    log_success "标准版单台部署完成！"
    echo ""
    echo "  应用目录：$DEPLOY_TARGET"
    echo "  服务管理：systemctl [start|stop|restart|status] $SERVICE_NAME"
    echo "  查看日志：journalctl -u $SERVICE_NAME -f"
    if [ -n "$DOMAIN" ]; then
        echo "  访问地址：https://$DOMAIN"
    fi
    echo ""
    echo "默认账号:"
    echo "  超级管理员: superadmin / super123"
    echo "  商户管理员: admin / admin123"
    echo ""
    log_warn "请及时修改默认管理员密码"
}

# ============================================================
# 集群部署（标准版/企业版）
# ============================================================
install_cluster() {
    log_step "开始$DEPLOY_NAME..."

    # 确定部署目录
    if [ "$DEPLOY_MODE" == "enterprise" ]; then
        CLUSTER_DIR="$DEPLOY_DIR/enterprise/cluster"
    else
        CLUSTER_DIR="$DEPLOY_DIR/enterprise-ultimate/cluster"
    fi

    # 检查目录
    if [ ! -d "$CLUSTER_DIR" ]; then
        log_error "未找到部署配置目录：$CLUSTER_DIR"
        exit 1
    fi

    if [ ! -f "$CLUSTER_DIR/deploy.sh" ]; then
        log_error "未找到部署脚本：$CLUSTER_DIR/deploy.sh"
        exit 1
    fi

    # 执行集群部署脚本
    log_info "执行集群部署脚本（节点角色：$NODE_ROLE）..."
    bash "$CLUSTER_DIR/deploy.sh" "$NODE_ROLE"

    echo ""
    log_success "$DEPLOY_NAME完成！"
    echo ""
    echo "  部署模式：$DEPLOY_NAME"
    echo "  节点角色：$NODE_ROLE"
    echo "  应用目录：$APP_DIR"
    echo "  环境变量：$CONFIG_DIR/.env"
    echo "  服务管理：systemctl [start|stop|restart|status] $SERVICE_NAME"
    echo "  查看日志：journalctl -u $SERVICE_NAME -f"
    echo ""

    if [ "$NODE_ROLE" == "master" ]; then
        log_info "主节点：定时任务已启用（自动备份、日志清理）"
    else
        log_info "从节点：定时任务未启用（由主节点执行）"
    fi

    echo ""
    log_warn "请编辑 $CONFIG_DIR/.env 配置数据库、Redis、NFS等信息"
    log_warn "所有节点的数据库、Redis、NFS配置必须完全相同"
    log_warn "配置Nginx负载均衡：参考 $CLUSTER_DIR/nginx.conf"
}

# ============================================================
# 显示部署后指南
# ============================================================
show_post_install_guide() {
    echo ""
    echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}${BOLD}║                    安装完成 - 后续步骤                     ║${NC}"
    echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""

    if [ "$DEPLOY_MODE" == "standard" ]; then
        echo "  1. 编辑环境变量配置："
        echo "     sudo nano $CONFIG_DIR/.env"
        echo ""
        echo "  2. 重启服务使配置生效："
        echo "     sudo systemctl restart foodflow"
        echo ""
        echo "  3. 配置SSL证书（推荐）："
        echo "     sudo apt-get install certbot python3-certbot-nginx"
        echo "     sudo certbot --nginx -d your-domain.com"
        echo ""
        echo "  4. 访问系统："
        echo "     前台点餐：https://your-domain.com"
        echo "     商户后台：https://your-domain.com/admin"
        echo "     服务员端：https://your-domain.com/waiter"
        echo "     后厨端：  https://your-domain.com/kitchen"
        echo "     超管后台：https://your-domain.com/super（默认 superadmin/super123，请尽快修改）"
        echo ""
    else
        echo "  1. 在所有应用服务器节点上编辑环境变量："
        echo "     sudo nano $CONFIG_DIR/.env"
        echo "     （所有节点的数据库、Redis、NFS配置必须相同）"
        echo ""
        echo "  2. 在所有节点上重启服务："
        echo "     sudo systemctl restart foodflow"
        echo ""
        echo "  3. 配置Nginx负载均衡（在Nginx服务器上）："
        echo "     参考部署目录中的 nginx.conf"
        echo "     sudo nginx -t && sudo systemctl reload nginx"
        echo ""
        echo "  4. 配置SSL证书："
        echo "     sudo certbot --nginx -d your-domain.com"
        echo ""
        echo "  5. 验证集群健康状态："
        echo "     curl -s http://节点1IP:3000/health"
        echo "     curl -s http://节点2IP:3000/health"
        echo ""
        if [ "$DEPLOY_MODE" == "enterprise-ultimate" ]; then
            echo "  6. 企业旗舰版超级管理员后台："
            echo "     https://your-domain.com/super"
            echo "     默认账号：superadmin / super123"
            echo "     （请尽快修改默认密码！）"
            echo ""
        fi
    fi

    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  常用命令："
    echo "    查看服务状态：sudo systemctl status foodflow"
    echo "    重启服务：    sudo systemctl restart foodflow"
    echo "    查看日志：    sudo journalctl -u $SERVICE_NAME -f"
    echo "    查看最近日志：sudo journalctl -u foodflow -n 100 --no-pager"
    echo ""
    echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
}

# ============================================================
# 主函数
# ============================================================
main() {
    # 显示横幅
    show_banner

    # 检查root权限
    check_root

    # 检查系统环境
    check_system

    # 选择部署模式
    select_deploy_mode "$1"

    # 选择节点角色（集群部署）
    select_node_role "$2"

    # 确认安装配置
    confirm_installation

    # 执行安装
    case $DEPLOY_MODE in
        standard)
            install_single
            ;;
        enterprise|enterprise-ultimate)
            install_cluster
            ;;
    esac

    # 显示部署后指南
    show_post_install_guide

    log_success "FoodFlow 点餐系统安装向导已完成！"
}

# 执行主函数
main "$@"