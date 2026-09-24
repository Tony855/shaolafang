#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:'127.0.0.1',user:'foodflow',password:'rYTAYpRWVVIFslJr',database:'ordering_system'});
  // 创建A01的session
  const token='qr_a01_test_'+Date.now();
  const exp=new Date(Date.now()+2*60*60*1000).toISOString();
  await c.execute('INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?,?,?,?,1)', ['A01', token, exp, new Date().toISOString()]);
  // 把B05的pending订单更新到A01
  const [res]=await c.execute(\"UPDATE orders SET table_name='A01', session_token=? WHERE table_name='B05' AND status='pending'\", [token]);
  console.log('转移了', res.affectedRows, '个订单到A01');
  console.log('A01二维码链接：https://foodflow.v2net.cc/?session='+token);
  // 查订单现在的状态
  const [orders]=await c.execute(\"SELECT id, table_name, customer_token, session_token FROM orders WHERE id=6\");
  console.log('订单现在的状态：', orders[0]);
  process.exit(0);
})()
"
EOF
