#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:'127.0.0.1',user:'foodflow',password:'rYTAYpRWVVIFslJr',database:'ordering_system'});
  const [rows]=await c.execute(\"SELECT id, table_name, customer_token, status FROM orders ORDER BY id DESC LIMIT 5\");
  console.log('最近订单：');
  rows.forEach(r=>console.log(r.id, r.table_name, r.customer_token, r.status));
  process.exit(0);
})()
"
EOF
