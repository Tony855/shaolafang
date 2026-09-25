#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
set -a
. ./.env
set +a
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  const [rows]=await c.execute(\"SELECT id, order_no, table_name, status, total, createdAt FROM orders ORDER BY id DESC LIMIT 10\");
  console.log('最近10个订单：');
  rows.forEach(r=>console.log('ID:', r.id, '桌号:', r.table_name, '状态:', r.status, '金额:', r.total, '时间:', r.createdAt));
  process.exit(0);
})()
"
EOF
