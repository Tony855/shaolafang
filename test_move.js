const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({ host: 'localhost', user: 'root', database: 'ordering_system' });
  // 查未结算订单
  const [rows] = await c.execute("SELECT id, table_name, customer_token, session_token, status FROM orders WHERE status='pending' ORDER BY id DESC LIMIT 10");
  console.log('当前未结算订单：');
  rows.forEach(r => console.log('ID:', r.id, '桌号:', r.table_name, '客户token:', r.customer_token, 'session:', r.session_token));
  
  // 模拟转移：把A05的订单转到A03
  const [res] = await c.execute("UPDATE orders SET table_name='A03', session_token='test_new_token' WHERE table_name='A05' AND status='pending'");
  console.log('\n转移了', res.affectedRows, '个订单到A03');
  
  // 查转移后的订单
  const [rows2] = await c.execute("SELECT id, table_name, customer_token, session_token FROM orders WHERE table_name='A03' AND status='pending'");
  console.log('\nA03现在的订单：');
  rows2.forEach(r => console.log('ID:', r.id, '客户token:', r.customer_token));
  
  // 模拟客户查询：客1的token是 test_customer_1，查A03的订单
  const [rows3] = await c.execute("SELECT * FROM orders WHERE table_name='A03' AND customer_token='test_customer_1' AND status!='canceled'");
  console.log('\n客1查询A03的结果：', rows3.length, '个订单');
  
  process.exit(0);
})()
