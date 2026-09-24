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
  // 把B01的pending订单转移到A01
  const [res]=await c.execute(\"UPDATE orders SET table_name='A01', session_token='qr_a01_new_test' WHERE table_name='B01' AND status='pending'\");
  console.log('转移了', res.affectedRows, '个订单到A01');
  // 查转移后的订单
  const [order]=await c.execute(\"SELECT id, customer_token FROM orders ORDER BY id DESC LIMIT 1\");
  console.log('转移的订单customer_token：', order[0].customer_token);
  process.exit(0);
})()
"
EOF
