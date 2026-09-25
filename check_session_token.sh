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
  // 查A02桌的有效session token
  const [tables]=await c.execute(\"SELECT table_name, session_token FROM tables WHERE table_name='A02'\");
  console.log('A02桌的session：', tables);
  // 查订单的session_token
  const [orders]=await c.execute(\"SELECT id, table_name, session_token, customer_token FROM orders WHERE customer_token='ct_test_123'\");
  console.log('订单：', orders);
  process.exit(0);
})()
"
EOF
