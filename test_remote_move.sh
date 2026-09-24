#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
# 测试转移接口
echo "=== 测试转移接口 ==="
curl -s -X POST http://localhost:3000/api/tables/move \
  -H "Content-Type: application/json" \
  -d '{"from_table":"A01","target_table":"A02","adminKey":"admin123"}'
echo ""
EOF
