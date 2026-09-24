#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
echo "=== 检查线上waiter.js的转移逻辑 ==="
grep -A5 "confirmTransfer" /var/www/foodflow/pages/waiter.js
EOF
