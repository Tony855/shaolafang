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
  const [rows]=await c.execute(\"SELECT id, table_name, customer_token, status FROM orders ORDER BY id DESC LIMIT 3\");
  console.log('最近的订单：');
  rows.forEach(r=>console.log('ID:', r.id, '桌号:', r.table_name, 'customer_token:', r.customer_token, '状态:', r.status));
  process.exit(0);
})()
"
EOF
