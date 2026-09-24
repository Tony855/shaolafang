const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({ host: 'localhost', user: 'root', database: 'ordering_system' });
  // 创建B01的有效session
  const token = 'test_b01_token_456';
  const exp = new Date(Date.now() + 2*60*60*1000).toISOString();
  await c.execute("INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?, ?, ?, ?, 1)", ['B01', token, exp, new Date().toISOString()]);
  console.log('B01的session token:', token);
  
  process.exit(0);
})()
