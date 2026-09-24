#!/bin/bash
cd ~/foodflow
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:'localhost',user:'root',password:'',database:'ordering_system'});
  const token='qr_b05_local_'+Date.now();
  const exp=new Date(Date.now()+2*60*60*1000).toISOString();
  await c.execute('INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?,?,?,?,1)', ['B05', token, exp, new Date().toISOString()]);
  console.log('B05链接：http://localhost:3000/?session='+token);
  process.exit(0);
})()
"
