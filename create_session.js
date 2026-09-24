const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({ host: 'localhost', user: 'root', database: 'ordering_system' });
  // 创建一个A03的有效session
  const token = 'test_valid_token_123';
  const exp = new Date(Date.now() + 2*60*60*1000).toISOString();
  await c.execute("INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?, ?, ?, ?, 1)", ['A03', token, exp, new Date().toISOString()]);
  console.log('创建了A03的session token:', token);
  
  // 把订单34的session_token改成这个新token
  await c.execute("UPDATE orders SET session_token=? WHERE id=34", [token]);
  console.log('更新订单34的session_token');
  
  process.exit(0);
})()
