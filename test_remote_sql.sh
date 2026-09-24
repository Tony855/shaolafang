#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:'127.0.0.1',user:'foodflow',password:'rYTAYpRWVVIFslJr',database:'ordering_system'});
  // 先查B05的pending订单
  const [rows1]=await c.execute(\"SELECT id, table_name, store_id, customer_token FROM orders WHERE table_name='B05' AND status='pending'\");
  console.log('B05的pending订单：', rows1);
  // 执行UPDATE看看影响多少行
  const [res]=await c.execute(\"UPDATE orders SET table_name='A01', session_token='test' WHERE table_name='B05' AND store_id=1 AND status='pending'\");
  console.log('UPDATE影响了', res.affectedRows, '行');
  // 再查A01的订单
  const [rows2]=await c.execute(\"SELECT id, table_name, customer_token FROM orders WHERE table_name='A01' AND status='pending'\");
  console.log('A01现在的pending订单：', rows2);
  process.exit(0);
})()
"
EOF
