#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
echo "=== routes目录文件 ==="
ls -la routes/
echo ""
echo "=== 找settings相关路由 ==="
grep -r "settings" routes/ --include="*.js" | head -20
echo ""
echo "=== server.js里挂载的路由 ==="
grep "require.*routes" server.js
EOF
