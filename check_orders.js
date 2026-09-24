const mysql = require('mysql2/promise');
(async () => {
  const c = await mysql.createConnection({ host: 'localhost', user: 'root', database: 'ordering_system' });
  const [rows] = await c.execute("SELECT id, table_name, customer_token, status FROM orders ORDER BY id DESC LIMIT 10");
  console.log('所有最近订单：');
  rows.forEach(r => console.log('ID:', r.id, '桌号:', r.table_name, '客户token:', r.customer_token, '状态:', r.status));
  
  process.exit(0);
})()
