#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
echo "=== 检查线上/tables/move接口的SQL ==="
grep -A20 "tables/move" /var/www/foodflow/routes/orders.js
EOF
