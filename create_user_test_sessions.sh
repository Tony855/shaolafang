#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
# 用项目里的db模块创建B05和A01的session
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:'localhost',user:'root',password:'',database:'ordering_system'});
  // 清掉旧session
  await c.execute('DELETE FROM scan_sessions');
  // 创建B05 session
  const b05token='qr_b05_user_test';
  const exp=new Date(Date.now()+2*60*60*1000).toISOString();
  await c.execute('INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?,?,?,?,1)', ['B05', b05token, exp, new Date().toISOString()]);
  // 创建A01 session
  const a01token='qr_a01_user_test';
  await c.execute('INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?,?,?,?,1)', ['A01', a01token, exp, new Date().toISOString()]);
  console.log('B05链接：https://foodflow.v2net.cc/?session='+b05token);
  console.log('A01链接：https://foodflow.v2net.cc/?session='+a01token);
  process.exit(0);
})()
"
EOF
