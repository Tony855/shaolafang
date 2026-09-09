#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ================== 统一配置：优先读取 .env，其次用下面的默认值 ==================
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
DOMAIN="${DOMAIN:-slf.v2net.cc}"   # 也可在 .env 中设置 DOMAIN
EMAIL="${EMAIL:-v2wallid@gmail.com}"           # 也可在 .env 中设置 EMAIL
# 注意：BACKEND_PORT 是"Nginx 反代到 Node 的内部端口"，必须和 Nginx 自己监听的 80/443
# 不同。不能直接沿用 .env 里 Node 当前的 PORT——那个值在没跑本脚本之前，很可能就是
# onekey-install.sh 默认写的 80（"不走 Nginx、直接对外"模式），如果这里也用 80，
# Nginx 就会把 443 的请求代理回自己的 80 端口，配合 certbot 的强制跳转 HTTPS，
# 会造成 ERR_TOO_MANY_REDIRECTS 死循环。因此这里只认独立的 BACKEND_PORT 变量。
BACKEND_PORT="${BACKEND_PORT:-3000}"
if [ "$BACKEND_PORT" = "80" ] || [ "$BACKEND_PORT" = "443" ]; then
  echo -e "${YELLOW}⚠️ BACKEND_PORT 不能设为 80/443（会与 Nginx 自己冲突并导致跳转死循环），已强制改为 3000。${NC}"
  BACKEND_PORT=3000
fi
# ==================================================

echo -e "${GREEN}=============================================="
echo "  配置 Nginx 反向代理 + 自动 SSL（烧腊坊系统）"
echo -e "==============================================${NC}"

# ---------- 1. 释放端口 80 ----------
PORT=80
PID=""
if command -v netstat >/dev/null 2>&1; then
  PID=$(netstat -tlnp 2>/dev/null | grep ":${PORT} " | awk '{print $7}' | cut -d/ -f1 | head -n1)
elif command -v ss >/dev/null 2>&1; then
  PID=$(ss -lntp "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -n1)
elif command -v lsof >/dev/null 2>&1; then
  PID=$(lsof -t -i:${PORT} 2>/dev/null | head -n1)
fi

if [ -n "$PID" ]; then
  PROC_NAME=$(ps -p "$PID" -o comm= 2>/dev/null || echo "")
  echo -e "${YELLOW}⚠️ 端口 80 被进程 ${PROC_NAME} (PID ${PID}) 占用。${NC}"
  
  # 如果是 node 或 nginx，则自动停止
  if [[ "$PROC_NAME" == *"node"* ]] || [[ "$PROC_NAME" == *"nginx"* ]]; then
    echo -e "${YELLOW}将自动停止该进程以释放端口...${NC}"
    kill -9 "$PID" 2>/dev/null || true
    sleep 1
    # 如果是 nginx，确保所有 worker 都停止
    if [[ "$PROC_NAME" == *"nginx"* ]]; then
      pkill -9 nginx 2>/dev/null || true
    fi
    echo -e "${GREEN}✅ 端口 80 已释放。${NC}"
  else
    echo -e "${RED}❌ 端口 80 被未知服务占用，请手动停止后重试。${NC}"
    exit 1
  fi
fi

# ---------- 2. 修改 Node.js 服务端口为 BACKEND_PORT ----------
ENV_FILE="/etc/default/shaolafang"
if [ -f "$ENV_FILE" ]; then
  sed -i "s/^PORT=.*/PORT=${BACKEND_PORT}/" "$ENV_FILE" || echo "PORT=${BACKEND_PORT}" >> "$ENV_FILE"
  echo -e "${GREEN}✅ 已更新环境变量文件，Node.js 将监听端口 ${BACKEND_PORT}。${NC}"
else
  echo -e "${YELLOW}⚠️ 未找到环境变量文件，手动创建...${NC}"
  mkdir -p /etc/default
  cat > "$ENV_FILE" <<EOF
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=$(cat /root/.mysql_root_password 2>/dev/null || echo "")
DB_DATABASE=ordering_system
PORT=${BACKEND_PORT}
EOF
  chmod 600 "$ENV_FILE"
fi
# 同步更新项目本地 .env，避免和 systemd 的 EnvironmentFile 端口显示不一致造成排查困扰
# （实际生效以 systemd EnvironmentFile 为准，这里只是保持两处一致，方便查看）
if [ -f .env ]; then
  sed -i "s/^PORT=.*/PORT=${BACKEND_PORT}/" .env || echo "PORT=${BACKEND_PORT}" >> .env
fi

# 重启 Node.js 服务（如果存在）
if systemctl list-unit-files | grep -q shaolafang.service; then
  systemctl daemon-reload
  systemctl start shaolafang.service
  echo -e "${GREEN}✅ Node.js 服务已重启，监听端口 ${BACKEND_PORT}。${NC}"
else
  cd "$(dirname "$0")" || exit
  nohup node server.js > server.log 2>&1 &
  echo -e "${GREEN}✅ Node.js 已手动启动，监听端口 ${BACKEND_PORT}。${NC}"
fi

# ---------- 3. 安装 Nginx 和 Certbot ----------
if ! command -v nginx >/dev/null 2>&1; then
  echo -e "${YELLOW}📦 安装 Nginx...${NC}"
  apt-get update
  apt-get install -y nginx
fi

if ! command -v certbot >/dev/null 2>&1; then
  echo -e "${YELLOW}📦 安装 Certbot 及 Nginx 插件...${NC}"
  apt-get update
  apt-get install -y certbot python3-certbot-nginx
fi

# ---------- 4. 配置 Nginx（先 HTTP，再尝试 SSL）----------
NGINX_CONF="/etc/nginx/sites-available/dianchan"
cat > "$NGINX_CONF" <<EOF
# HTTP 配置（未启用 SSL 时使用）
server {
    listen 80;
    server_name ${DOMAIN};

    # 静态文件
    location /uploads/ {
        alias $(pwd)/uploads/;
        expires 1d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# 测试配置
nginx -t || { echo -e "${RED}❌ Nginx 配置错误，退出。${NC}"; exit 1; }

# 重启 Nginx
systemctl restart nginx || service nginx restart
echo -e "${GREEN}✅ Nginx HTTP 配置完成。${NC}"

# ---------- 5. 尝试申请 SSL 证书 ----------
# 检查域名是否解析到本机
if host "$DOMAIN" >/dev/null 2>&1; then
  echo -e "${YELLOW}🌐 域名解析正常，正在申请 SSL 证书...${NC}"
  # 使用 certbot 自动配置 Nginx
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL" --redirect; then
    echo -e "${GREEN}✅ SSL 证书已安装，HTTPS 已启用。${NC}"
    echo -e "${GREEN}👉 访问地址：https://${DOMAIN}${NC}"
  else
    echo -e "${RED}❌ SSL 证书申请失败，将保持 HTTP 访问。${NC}"
    echo -e "${YELLOW}请检查域名解析或防火墙，可手动运行：certbot --nginx -d ${DOMAIN}${NC}"
  fi
else
  echo -e "${RED}⚠️ 域名 ${DOMAIN} 未解析到本机，跳过 SSL 申请。${NC}"
  echo -e "${YELLOW}访问地址：http://${DOMAIN}（或使用 IP 访问）${NC}"
fi

echo -e "${GREEN}✅ 所有配置完成。${NC}"