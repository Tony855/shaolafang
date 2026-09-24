const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({ host: 'localhost', user: 'root', database: 'ordering_system' });
  // 创建B02的有效session
  const token = 'test_b02_token_789';
  const exp = new Date(Date.now() + 2*60*60*1000).toISOString();
  await c.execute("INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?, ?, ?, ?, 1)", ['B02', token, exp, new Date().toISOString()]);
  // 更新订单34的session_token
  await c.execute("UPDATE orders SET session_token=? WHERE id=34", [token]);
  console.log('B02的session token:', token);
  
  process.exit(0);
})()
