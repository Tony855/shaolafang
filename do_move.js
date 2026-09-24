const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({ host: 'localhost', user: 'root', database: 'ordering_system' });
  // 直接把A03的订单转到B01，session_token改成新的B01 token
  const [res] = await c.execute("UPDATE orders SET table_name='B01', session_token='test_b01_token_456' WHERE table_name='A03' AND status='pending'");
  console.log('转移了', res.affectedRows, '个订单到B01');
  
  // 查一下
  const [rows] = await c.execute("SELECT id, table_name, customer_token FROM orders WHERE table_name='B01' AND status='pending'");
  console.log('B01现在的订单：');
  rows.forEach(r => console.log('ID:', r.id, '客户token:', r.customer_token));
  
  process.exit(0);
})()
