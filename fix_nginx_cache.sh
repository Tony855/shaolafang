#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
# 备份原配置
cp /etc/nginx/conf.d/foodflow.conf /etc/nginx/conf.d/foodflow.conf.bak.$(date +%Y%m%d%H%M%S)

# 写入新配置，加缓存控制
cat > /etc/nginx/conf.d/foodflow.conf << 'NGINXCONF'
server {
    listen 80;
    server_name foodflow.v2net.cc;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name foodflow.v2net.cc;

    ssl_certificate /etc/letsencrypt/live/foodflow.v2net.cc/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/foodflow.v2net.cc/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    root /var/www/foodflow;
    index index.html;

    # HTML文件不缓存，每次都拿最新的
    location ~* \.html$ {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        add_header Pragma "no-cache";
        expires 0;
        proxy_pass http://127.0.0.1:3000;
    }

    # CSS、JS文件缓存7天
    location ~* \.(css|js)$ {
        add_header Cache-Control "public, max-age=604800, immutable";
        proxy_pass http://127.0.0.1:3000;
    }

    # 图片、字体缓存30天
    location ~* \.(png|jpg|jpeg|gif|webp|ico|svg|woff|woff2|ttf|eot)$ {
        add_header Cache-Control "public, max-age=2592000, immutable";
        proxy_pass http://127.0.0.1:3000;
    }

    # 其他请求代理到后端
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINXCONF

# 测试Nginx配置
nginx -t
# 重载Nginx
systemctl reload nginx
echo "=== Nginx配置更新完成！ ==="
EOF
