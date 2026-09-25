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
  // 创建一个测试订单在A01
  await c.execute(\"INSERT INTO orders (order_no, table_name, session_token, customer_token, items, total, status, store_id, createdAt) VALUES (?, 'A01', 'qr_a01_test', 'ct_test_123', ?, 8.50, 'pending', 1, NOW())\", ['1126092500099', JSON.stringify([{name:'招牌烧腊饭', price:8.5, quantity:1, emoji:'🍱'}])]);
  console.log('测试订单创建成功！在A01桌');
  process.exit(0);
})()
"
EOF
