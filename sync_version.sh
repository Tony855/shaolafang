#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
git reset --hard origin/main
git pull https://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@github.com/Tony855/shaolafang.git main
systemctl restart foodflow
sleep 2
echo "=== 验证版本号 ==="
grep "customer.js" index.html
echo "=== 服务状态 ==="
systemctl status foodflow --no-pager | head -3
EOF
