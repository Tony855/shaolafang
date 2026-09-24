#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
git pull https://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@github.com/Tony855/shaolafang.git main
systemctl restart foodflow
sleep 2
systemctl status foodflow --no-pager | head -5
echo "=== 线上已同步最新代码 ==="
EOF
