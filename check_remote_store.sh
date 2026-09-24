#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:'127.0.0.1',user:'foodflow',password:'rYTAYpRWVVIFslJr',database:'ordering_system'});
  // 查waiter的storeId
  const [waiters]=await c.execute(\"SELECT id, username, store_id FROM waiters\");
  console.log('服务员：', waiters);
  // 查所有订单的store_id
  const [orders]=await c.execute(\"SELECT id, table_name, store_id, status FROM orders ORDER BY id DESC LIMIT 5\");
  console.log('订单：', orders);
  process.exit(0);
})()
"
EOF
