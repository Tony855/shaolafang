const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({ host: 'localhost', user: 'root', database: 'ordering_system' });
  
  // 1. 创建A05的有效session（模拟A05的二维码）
  const a05_token = 'qr_a05_' + Date.now();
  const exp = new Date(Date.now() + 2*60*60*1000).toISOString();
  await c.execute("INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?, ?, ?, ?, 1)", ['A05', a05_token, exp, new Date().toISOString()]);
  console.log('=== A05二维码链接 ===');
  console.log('http://localhost:3000/?session=' + a05_token);
  
  // 2. 创建B03的有效session（模拟B03的二维码）
  const b03_token = 'qr_b03_' + Date.now();
  await c.execute("INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES (?, ?, ?, ?, 1)", ['B03', b03_token, exp, new Date().toISOString()]);
  console.log('\n=== B03二维码链接 ===');
  console.log('http://localhost:3000/?session=' + b03_token);
  
  process.exit(0);
})()
