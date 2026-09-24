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
  // 把B05的pending订单转移到A01
  const [res]=await c.execute(\"UPDATE orders SET table_name='A01', session_token='qr_a01_user_test' WHERE table_name='B05' AND status='pending'\");
  console.log('转移了', res.affectedRows, '个订单到A01');
  process.exit(0);
})()
"
EOF
