#!/bin/bash
cd ~/foodflow
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:'localhost',user:'root',password:'',database:'ordering_system'});
  // 创建A01的session
  const token='qr_a01_local_'+Date.now();
  const exp=new Date(Date.now()+2*60*60*1000).toISOString();
  await c.execute('INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?,?,?,?,1)', ['A01', token, exp, new Date().toISOString()]);
  // 把B05的pending订单转移到A01
  const [res]=await c.execute(\"UPDATE orders SET table_name='A01', session_token=? WHERE table_name='B05' AND status='pending'\", [token]);
  console.log('转移了', res.affectedRows, '个订单到A01');
  console.log('A01链接：http://localhost:3000/?session='+token);
  process.exit(0);
})()
"
