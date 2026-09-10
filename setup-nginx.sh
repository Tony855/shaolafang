#!/usr/bin/env bash
cd "$(dirname "$0")"

# 开启调试模式（取消下面注释可输出详细执行过程）
# DEBUG=true

if [ "${DEBUG:-false}" = "true" ]; then
  set -x
fi

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ================== 统一配置 ==================
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi
DOMAIN="${DOMAIN:-shaolafang.v2net.cc}"
EMAIL="${EMAIL:-v2wallid@gmail.com}"
BACKEND_PORT="${BACKEND_PORT:-3000}"
if [ "$BACKEND_PORT" = "80" ] || [ "$BACKEND_PORT" = "443" ]; then
  echo -e "${YELLOW}⚠️ BACKEND_PORT 不能设为 80/443，强制改为 3000。${NC}"
  BACKEND_PORT=3000
fi
# ==============================================

echo -e "${GREEN}=============================================="
echo "  Configure Nginx Reverse Proxy + Auto SSL (FoodFlow System)"
echo -e "==============================================${NC}"

# ---------- 函数：检查命令是否存在 ----------
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# ---------- 函数：释放端口（更兼容） ----------
kill_port() {
  local port=$1
  local pids=""
  
  # 尝试 ss
  if command_exists ss; then
    # 使用基础正则（不使用 -P）
    pids=$(ss -lntp "sport = :${port}" 2>/dev/null | awk '{print $7}' | grep -Eo 'pid=[0-9]+' | grep -Eo '[0-9]+' | tr '\n' ' ')
  elif command_exists netstat; then
    pids=$(netstat -tlnp 2>/dev/null | grep ":${port} " | awk '{print $7}' | cut -d/ -f1 | tr '\n' ' ')
  elif command_exists lsof; then
    pids=$(lsof -t -i:${port} 2>/dev/null | tr '\n' ' ')
  fi
  
  if [ -n "$pids" ]; then
    echo -e "${YELLOW}⚠️ 端口 ${port} 被进程 PID: ${pids} 占用。${NC}"
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then
        proc_name=$(ps -p "$pid" -o comm= 2>/dev/null || echo "")
        echo -e "${YELLOW}终止进程 ${proc_name} (PID ${pid})${NC}"
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
    sleep 1
  fi
  
  # 兜底：fuser
  if command_exists fuser; then
    if fuser -s ${port}/tcp 2>/dev/null; then
      echo -e "${YELLOW}使用 fuser 强制释放端口 ${port}...${NC}"
      fuser -k ${port}/tcp 2>/dev/null || true
      sleep 1
    fi
  fi
}

# ---------- 1. 释放端口 80 ----------
echo -e "${YELLOW}正在释放端口 80...${NC}"
systemctl stop nginx 2>/dev/null || true
pkill -9 nginx 2>/dev/null || true
kill_port 80

# 等待端口释放（最多 5 秒）
for i in {1..5}; do
  if command_exists ss && ! ss -lnt "sport = :80" | grep -q ":80"; then
    break
  elif command_exists netstat && ! netstat -tln | grep -q ":80 "; then
    break
  else
    echo -e "${YELLOW}端口 80 仍被占用，等待 1 秒...${NC}"
    sleep 1
    if [ $i -eq 5 ]; then
      if command_exists fuser; then
        fuser -k 80/tcp 2>/dev/null || true
        sleep 1
      fi
    fi
  fi
done
echo -e "${GREEN}✅ 端口 80 已释放。${NC}"

# ---------- 2. 配置 Node.js 后端端口 ----------
ENV_FILE="/etc/default/shaolafang"
if [ -f "$ENV_FILE" ]; then
  sed -i "s/^PORT=.*/PORT=${BACKEND_PORT}/" "$ENV_FILE" || echo "PORT=${BACKEND_PORT}" >> "$ENV_FILE"
else
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
if [ -f .env ]; then
  sed -i "s/^PORT=.*/PORT=${BACKEND_PORT}/" .env || echo "PORT=${BACKEND_PORT}" >> .env
fi

if systemctl list-unit-files | grep -q shaolafang.service; then
  systemctl daemon-reload
  systemctl restart shaolafang.service
else
  pkill -9 node 2>/dev/null || true
  nohup node server.js > server.log 2>&1 &
fi
echo -e "${GREEN}✅ Node.js 已监听端口 ${BACKEND_PORT}。${NC}"

# ---------- 3. 安装依赖 ----------
if ! command_exists nginx; then
  echo -e "${YELLOW}📦 安装 Nginx...${NC}"
  apt-get update && apt-get install -y nginx
fi
if ! command_exists certbot; then
  echo -e "${YELLOW}📦 安装 Certbot...${NC}"
  apt-get update && apt-get install -y certbot python3-certbot-nginx
fi

# ---------- 4. 配置 Nginx ----------
NGINX_CONF="/etc/nginx/sites-available/dianchan"
cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
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
nginx -t || { echo -e "${RED}❌ Nginx 配置错误，退出。${NC}"; exit 1; }

# ---------- 5. 启动 Nginx（带重试） ----------
start_nginx() {
  systemctl restart nginx 2>/dev/null || service nginx restart 2>/dev/null
}
if ! start_nginx; then
  echo -e "${RED}❌ 第一次启动失败，再次释放端口...${NC}"
  kill_port 80
  sleep 2
  if ! start_nginx; then
    echo -e "${RED}❌ 启动失败，请手动检查端口占用。${NC}"
    exit 1
  fi
fi
echo -e "${GREEN}✅ Nginx HTTP 已启动。${NC}"

# ---------- 6. 自动申请 SSL 证书 ----------
SSL_ENABLED=false
if command_exists host && host "$DOMAIN" >/dev/null 2>&1; then
  echo -e "${YELLOW}🌐 域名解析正常，正在申请 SSL 证书...${NC}"
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL" --redirect; then
    SSL_ENABLED=true
    echo -e "${GREEN}✅ SSL 证书安装成功，已启用 HTTPS。${NC}"
    echo -e "${GREEN}👉 访问地址：https://${DOMAIN}${NC}"
  else
    echo -e "${YELLOW}⚠️ Nginx 插件申请失败，尝试 standalone 模式...${NC}"
    systemctl stop nginx
    kill_port 80
    if certbot certonly --standalone -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL"; then
      echo -e "${GREEN}✅ 证书获取成功，重新配置 Nginx...${NC}"
      cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$server_name\$request_uri;
}
server {
    listen 443 ssl;
    server_name ${DOMAIN};
    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
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
      nginx -t && systemctl start nginx
      SSL_ENABLED=true
      echo -e "${GREEN}✅ HTTPS 已启用（standalone 模式）。${NC}"
      echo -e "${GREEN}👉 访问地址：https://${DOMAIN}${NC}"
    else
      echo -e "${RED}❌ SSL 申请失败，仅 HTTP 访问。${NC}"
      echo -e "${YELLOW}请检查域名解析或防火墙，然后手动运行：${NC}"
      echo -e "  certbot --nginx -d ${DOMAIN}"
      systemctl start nginx
    fi
  fi
else
  echo -e "${RED}⚠️ 域名 ${DOMAIN} 未解析到本机或 host 命令不可用，跳过 SSL。${NC}"
  echo -e "${YELLOW}访问地址：http://${DOMAIN}（或 IP）${NC}"
fi

echo -e "${GREEN}✅ 所有配置完成。${NC}"
if [ "$SSL_ENABLED" = false ]; then
  echo -e "${YELLOW}提示：SSL 未启用，你可以稍后手动运行 certbot 命令。${NC}"
fi