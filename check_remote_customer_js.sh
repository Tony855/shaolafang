#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
echo "=== 检查线上customer.js里有没有自动生成customer_token的代码 ==="
grep -A5 "自动生成唯一customer_token" /var/www/foodflow/pages/customer.js
EOF
