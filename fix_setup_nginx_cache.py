with open('setup-nginx.sh', 'r', encoding='utf-8') as f:
    content = f.read()

# 修改HTTP配置部分，加缓存规则
old_http = '''cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN:-_};

    client_max_body_size 20M;

    location /uploads/ {
        alias $APP_DIR/uploads/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_cache_bypass \\$http_upgrade;
    }
}
EOF'''

new_http = '''cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN:-_};

    client_max_body_size 20M;

    # HTML文件不缓存，每次都拿最新
    location ~* \\.html$ {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header Pragma "no-cache";
        expires 0;
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
    }

    # CSS、JS缓存7天
    location ~* \\.(css|js)$ {
        add_header Cache-Control "public, max-age=604800, immutable";
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
    }

    # 图片、字体缓存30天
    location ~* \\.(png|jpg|jpeg|gif|webp|ico|svg|woff|woff2|ttf|eot)$ {
        add_header Cache-Control "public, max-age=2592000, immutable";
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
    }

    location /uploads/ {
        alias $APP_DIR/uploads/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_cache_bypass \\$http_upgrade;
    }
}
EOF'''

if old_http in content:
    content = content.replace(old_http, new_http)
    print("修改HTTP配置成功！")
else:
    print("没找到HTTP配置部分")

# 修改HTTPS standalone配置部分
old_https = '''cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\\$server_name\\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 20M;

    location /uploads/ {
        alias $APP_DIR/uploads/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_cache_bypass \\$http_upgrade;
    }
}
EOF'''

new_https = '''cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\\$server_name\\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 20M;

    # HTML文件不缓存，每次都拿最新
    location ~* \\.html$ {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header Pragma "no-cache";
        expires 0;
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
    }

    # CSS、JS缓存7天
    location ~* \\.(css|js)$ {
        add_header Cache-Control "public, max-age=604800, immutable";
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
    }

    # 图片、字体缓存30天
    location ~* \\.(png|jpg|jpeg|gif|webp|ico|svg|woff|woff2|ttf|eot)$ {
        add_header Cache-Control "public, max-age=2592000, immutable";
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
    }

    location /uploads/ {
        alias $APP_DIR/uploads/;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_cache_bypass \\$http_upgrade;
    }
}
EOF'''

if old_https in content:
    content = content.replace(old_https, new_https)
    print("修改HTTPS配置成功！")
else:
    print("没找到HTTPS配置部分")

with open('setup-nginx.sh', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
