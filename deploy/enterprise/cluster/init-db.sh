#!/bin/bash
# ============================================================
# FoodFlow 标准版 - 数据库初始化脚本
# ============================================================
set -e

DB_HOST="${DB_HOST:?请设置 DB_HOST}"
DB_PORT="${DB_PORT:-3306}"
DB_ROOT_USER="${DB_ROOT_USER:-root}"
DB_ROOT_PASS="${DB_ROOT_PASSWORD:?请设置 DB_ROOT_PASSWORD}"
DB_NAME="foodflow_enterprise"
DB_USER="${DB_USER:-foodflow}"
DB_PASS="${DB_PASSWORD:?请设置 DB_PASSWORD（32-128 位字母、数字、下划线或连字符）}"
if [[ ! "$DB_PASS" =~ ^[A-Za-z0-9_-]{32,128}$ ]]; then
  echo "错误：DB_PASSWORD 必须为 32-128 位字母、数字、下划线或连字符" >&2
  exit 1
fi

echo "初始化标准版数据库..."

MYSQL_PWD="$DB_ROOT_PASS" mysql -h"$DB_HOST" -P"$DB_PORT" -u"$DB_ROOT_USER" <<EOF
CREATE DATABASE IF NOT EXISTS $DB_NAME DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'%' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'%';
FLUSH PRIVILEGES;
EOF

cd /var/www/foodflow
DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USER=$DB_USER DB_PASSWORD=$DB_PASS DB_DATABASE=$DB_NAME INIT_CRED_FILE=/var/lib/foodflow/initial-credentials.txt node server.js --init-only

echo "标准版数据库初始化完成！"
