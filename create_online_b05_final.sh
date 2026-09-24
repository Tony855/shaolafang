#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
# 创建B05和A01的session
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:'localhost',user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  // B05 session
  const b05token='qr_b05_test_'+Date.now();
  const exp=new Date(Date.now()+2*60*60*1000).toISOString();
  await c.execute('INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?,?,?,?,1)', ['B05', b05token, exp, new Date().toISOString()]);
  console.log('B05链接：https://foodflow.v2net.cc/?session='+b05token);
  process.exit(0);
})()
"
EOF
