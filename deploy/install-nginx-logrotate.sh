#!/bin/bash
# 安装 Nginx 日志切割配置（部署时跑一次即可）
# 用法: sudo bash deploy/install-nginx-logrotate.sh

set -e

if [ "$EUID" -ne 0 ]; then
    echo "❌ 请用 root 运行：sudo bash $0"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/nginx/logrotate-foodflow-nginx.conf"
DST="/etc/logrotate.d/foodflow-nginx"

if ! command -v logrotate >/dev/null 2>&1; then
    echo "[INFO] 安装 logrotate..."
    apt-get install -y logrotate
fi

cp "$SRC" "$DST"
chmod 644 "$DST"

echo "✅ 已安装 $DST"
echo ""
echo "验证："
logrotate -d "$DST" 2>&1 | head -5
