#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
echo "=== 服务状态 ==="
systemctl status foodflow --no-pager | head -10
echo ""
echo "=== 最近日志 ==="
journalctl -u foodflow -n 20 --no-pager
EOF
