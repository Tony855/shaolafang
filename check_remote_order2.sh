#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:'127.0.0.1',user:'foodflow',password:'rYTAYpRWVVIFslJr',database:'ordering_system'});
  const [rows]=await c.execute(\"SELECT id, table_name, customer_token, session_token, status FROM orders WHERE id=1126092400004\");
  console.log('转移后的订单：');
  console.log(rows[0]);
  process.exit(0);
})()
"
EOF
