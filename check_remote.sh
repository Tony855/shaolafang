#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
echo "=== 最新提交 ==="
git log --oneline -3
echo ""
echo "=== 检查转移接口 ==="
grep -n "tables/move" routes/orders.js
echo ""
echo "=== 服务状态 ==="
systemctl status foodflow --no-pager | head -5
EOF
