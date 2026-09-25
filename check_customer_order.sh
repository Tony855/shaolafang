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
  // 查customer_token=ct_test_123的所有订单
  const [rows]=await c.execute(\"SELECT id, order_no, table_name, customer_token, status, total FROM orders WHERE customer_token='ct_test_123' AND status!='canceled'\");
  console.log('客户ct_test_123的所有订单：');
  console.log(rows);
  process.exit(0);
})()
"
EOF
