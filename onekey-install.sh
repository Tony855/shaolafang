#!/usr/bin/env bash
set -euo pipefail

# 确保以 root 运行
if [ "$EUID" -ne 0 ]; then
  echo "❌ 请以 root 用户运行此脚本（使用 sudo）"
  exit 1
fi

cd "$(dirname "$0")"
INSTALL_DIR="$(pwd)"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=============================================="
echo "  FoodFlow QR Ordering System - Linux One-Click Install"
echo -e "==============================================${NC}"

# ---------- 1. 安装 Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  echo -e "${YELLOW}⚠️ 未检测到 Node.js，正在自动安装 Node.js V20+...${NC}"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y ca-certificates curl gnupg
    apt-get install -y --no-install-recommends nodejs npm || true
    if ! command -v node >/dev/null 2>&1; then
      echo -e "${YELLOW}⚠️ apt 安装失败或空间不足，改用 Node.js 官方二进制包安装...${NC}"
      NODE_ARCH="$(uname -m)"
      if [ "$NODE_ARCH" = "x86_64" ]; then
        NODE_ARCH="x64"
      elif [ "$NODE_ARCH" = "aarch64" ]; then
        NODE_ARCH="arm64"
      fi
      NODE_VERSION="v20.19.2"
      NODE_TARBALL="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.gz"
      curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}" -o "/tmp/${NODE_TARBALL}"
      tar -xzf "/tmp/${NODE_TARBALL}" -C /usr/local --strip-components=1
      export PATH="/usr/local/bin:${PATH}"
    fi
  else
    echo -e "${RED}❌ 当前系统不支持自动安装 Node.js，请手动安装 Node.js 20+。${NC}"
    exit 1
  fi
fi

if ! command -v npm >/dev/null 2>&1; then
  echo -e "${YELLOW}⚠️ 未检测到 npm，正在安装...${NC}"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get install -y --no-install-recommends npm || true
  fi
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo -e "${RED}❌ Node.js 版本过低，当前主版本：${NODE_MAJOR}，需要 20+。${NC}"
  exit 1
fi

echo -e "${GREEN}✅ Node.js $(node -v)${NC}"

# ---------- 2. 安装 MySQL/MariaDB ----------
MYSQL_ROOT_PASSWORD_FILE="/root/.mysql_root_password"
MYSQL_PASSWORD=""
if [ -f "$MYSQL_ROOT_PASSWORD_FILE" ]; then
  MYSQL_PASSWORD=$(cat "$MYSQL_ROOT_PASSWORD_FILE")
fi

# 检查 MySQL 客户端是否可用（MariaDB 也提供 mysql 命令）
if ! command -v mysql >/dev/null 2>&1; then
  echo -e "${YELLOW}⚠️ 未检测到 MySQL/MariaDB，正在尝试安装...${NC}"
  if command -v apt-get >/dev/null 2>&1; then
    # 随机生成 root 密码
    MYSQL_PASSWORD=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)
    echo "$MYSQL_PASSWORD" > "$MYSQL_ROOT_PASSWORD_FILE"
    chmod 600 "$MYSQL_ROOT_PASSWORD_FILE"
    
    export DEBIAN_FRONTEND=noninteractive
    # 优先安装 default-mysql-server（Debian/Ubuntu 元包，自动选择 MySQL 或 MariaDB）
    echo -e "${YELLOW}正在安装数据库服务器...${NC}"
    if apt-get install -y default-mysql-server 2>/dev/null; then
      DB_SERVICE="mysql"
    elif apt-get install -y mysql-server 2>/dev/null; then
      DB_SERVICE="mysql"
    else
      echo -e "${YELLOW}安装 mariadb-server...${NC}"
      apt-get install -y mariadb-server
      DB_SERVICE="mariadb"
    fi

    # 启动服务（兼容 systemd 和非 systemd 环境）
    if command -v systemctl >/dev/null 2>&1; then
      systemctl start $DB_SERVICE 2>/dev/null || systemctl start mariadb 2>/dev/null || systemctl start mysql 2>/dev/null || service $DB_SERVICE start 2>/dev/null || service mariadb start 2>/dev/null || service mysql start 2>/dev/null || true
      systemctl enable $DB_SERVICE 2>/dev/null || systemctl enable mariadb 2>/dev/null || systemctl enable mysql 2>/dev/null || true
    else
      service $DB_SERVICE start 2>/dev/null || service mariadb start 2>/dev/null || service mysql start 2>/dev/null || true
    fi

    # 等待数据库启动
    sleep 3

    # 设置 root 密码（兼容 MySQL 和 MariaDB）
    if mysql -u root -e "SELECT 1" >/dev/null 2>&1; then
      # root 无密码，设置密码
      mysql -u root -e "ALTER USER 'root'@'localhost' IDENTIFIED BY '$MYSQL_PASSWORD'; FLUSH PRIVILEGES;" 2>/dev/null ||       mysqladmin -u root password "$MYSQL_PASSWORD" 2>/dev/null || true
    fi
  else
    echo -e "${RED}❌ 当前系统不支持自动安装数据库，请手动安装 MySQL 或 MariaDB。${NC}"
    exit 1
  fi
else
  echo -e "${GREEN}✅ MySQL/MariaDB 已安装。${NC}"
  # 如果密码文件不存在，尝试用空密码连接，若失败则提示
  if [ -z "$MYSQL_PASSWORD" ]; then
    if mysql -u root -e "SELECT 1" >/dev/null 2>&1; then
      MYSQL_PASSWORD=""
      echo -e "${YELLOW}⚠️ 数据库 root 密码为空，将使用空密码连接。${NC}"
    else
      echo -e "${RED}❌ 数据库 root 密码未知，且未找到密码文件。${NC}"
      echo -e "${YELLOW}请手动输入 root 密码，或创建文件 $MYSQL_ROOT_PASSWORD_FILE 并写入密码。${NC}"
      read -s -p "请输入数据库 root 密码: " MYSQL_PASSWORD
      echo
      echo "$MYSQL_PASSWORD" > "$MYSQL_ROOT_PASSWORD_FILE"
      chmod 600 "$MYSQL_ROOT_PASSWORD_FILE"
    fi
  fi
fi

# ---------- 3. 创建数据库 ----------
echo -e "${YELLOW}🗄️ 正在创建数据库（如果不存在）...${NC}"
mysql -u root -p"$MYSQL_PASSWORD" -e "CREATE DATABASE IF NOT EXISTS ordering_system CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p"$MYSQL_PASSWORD" -e "GRANT ALL PRIVILEGES ON ordering_system.* TO 'root'@'localhost' WITH GRANT OPTION;"
mysql -u root -p"$MYSQL_PASSWORD" -e "FLUSH PRIVILEGES;"

# ---------- 4. 安装 Node.js 依赖 ----------
if [ ! -d node_modules ]; then
  echo -e "${YELLOW}📦 正在安装 Node.js 依赖（包含 mysql2）...${NC}"
  npm install --omit=dev
else
  echo -e "${YELLOW}📦 依赖已存在，跳过安装。${NC}"
fi

# 确保 uploads 目录存在
mkdir -p uploads data

# ---------- 5. 初始化数据库表和数据 ----------
echo -e "${YELLOW}🗄️ 正在初始化数据库表、菜单、桌号、货币、分类和后台密钥...${NC}"
DB_HOST="localhost" DB_USER="root" DB_PASSWORD="$MYSQL_PASSWORD" DB_DATABASE="ordering_system" \
node server.js --init-only

# ---------- 5b. 写入统一配置文件 .env ----------
# 本地 .env 供 server.js 内置的轻量加载器读取（无 systemd 时也能正常工作），
# 与下面写入 /etc/default/shaolafang 的内容保持一致，避免配置分散。
# 检测是否能使用 80 端口（需要 root 或 capabilities）
SERVER_PORT=3000

cat > "${INSTALL_DIR}/.env" <<EOF
PORT=${SERVER_PORT}
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=$MYSQL_PASSWORD
DB_DATABASE=ordering_system
DB_PORT=3306
EOF
chmod 600 "${INSTALL_DIR}/.env"

# ---------- 6. 配置 systemd 服务（包含环境变量） ----------
if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
    echo -e "${YELLOW}🔄 正在配置 systemd 服务以实现开机自启...${NC}"
    SERVICE_FILE="/etc/systemd/system/shaolafang.service"
    ENV_FILE="/etc/default/shaolafang"
    cat > "$ENV_FILE" <<EOF
# FoodFlow System Environment Variables（与 ${INSTALL_DIR}/.env 保持一致）
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=$MYSQL_PASSWORD
DB_DATABASE=ordering_system
PORT=80
EOF
    chmod 600 "$ENV_FILE"

    # 确定服务依赖（如果 mariadb 存在则依赖 mariadb.service，否则 mysql.service）
    DB_DEPEND="mysql.service"
    if systemctl list-unit-files 2>/dev/null | grep -q mariadb.service; then
      DB_DEPEND="mariadb.service"
    fi

    # 确定 node 路径
    NODE_PATH="$(command -v node)"

    cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=FoodFlow QR Ordering System
After=network.target ${DB_DEPEND}

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_PATH} ${INSTALL_DIR}/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable shaolafang.service
    systemctl start shaolafang.service
    echo -e "${GREEN}✅ systemd 服务已配置并启动。${NC}"
    echo -e "${GREEN}👉 手动管理服务：systemctl {start|stop|restart|status} shaolafang${NC}"
else
    echo -e "${YELLOW}⚠️ 未检测到可用的 systemd，使用 nohup 后台启动...${NC}"
    # 非 systemd 环境（如 WSL），使用 nohup 后台启动
    cd "${INSTALL_DIR}"
    nohup node server.js > /var/log/shaolafang.log 2>&1 &
    echo $! > /var/run/shaolafang.pid
    echo -e "${GREEN}✅ 服务已后台启动，PID: $(cat /var/run/shaolafang.pid)${NC}"
    echo -e "${YELLOW}👉 查看日志：tail -f /var/log/shaolafang.log${NC}"
    echo -e "${YELLOW}👉 停止服务：kill \$(cat /var/run/shaolafang.pid)${NC}"
fi

# ---------- 7. 获取访问地址 ----------
SERVER_ADDR="localhost"
FQDN=$(hostname -f 2>/dev/null || echo "")
if [ -n "$FQDN" ] && [ "$FQDN" != "localhost" ] && [ "$FQDN" != "localhost.localdomain" ] && [ "$FQDN" != "(none)" ]; then
    SERVER_ADDR="$FQDN"
else
    SHORT_NAME=$(hostname 2>/dev/null || echo "")
    if [ -n "$SHORT_NAME" ] && [ "$SHORT_NAME" != "localhost" ] && [ "$SHORT_NAME" != "localhost.localdomain" ] && [ "$SHORT_NAME" != "(none)" ]; then
        SERVER_ADDR="$SHORT_NAME"
    else
        IP=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "")
        if [ -n "$IP" ]; then
            SERVER_ADDR="$IP"
        fi
    fi
fi

# ---------- 8. 输出完成信息 ----------
echo ""
echo -e "${GREEN}✅ 安装完成。${NC}"
echo -e "${GREEN}👉 顾客点餐页：http://${SERVER_ADDR}${NC}"
echo -e "${GREEN}👉 后台管理：http://${SERVER_ADDR}/login${NC}"
echo -e "${GREEN}👉 默认后台密码：admin123${NC}"
echo -e "${YELLOW}👉 数据库 root 密码已保存至：${MYSQL_ROOT_PASSWORD_FILE}${NC}"
echo -e "${YELLOW}👉 如需隐藏端口号，可执行：bash setup-nginx.sh${NC}"
echo -e "${GREEN}👉 服务已通过 systemd 启动，系统重启后会自动运行。${NC}"