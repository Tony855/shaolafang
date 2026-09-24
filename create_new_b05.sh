#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
# 用项目里的db模块创建session
node -e "
const db = require('./db');
(async()=>{
  const token='qr_b05_new_'+Date.now();
  const exp=new Date(Date.now()+2*60*60*1000).toISOString();
  await db.runAsync('INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?,?,?,?,1)', ['B05', token, exp, new Date().toISOString()]);
  console.log('B05链接：https://foodflow.v2net.cc/?session='+token);
  process.exit(0);
})()
"
EOF
