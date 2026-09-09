const mysql = require('mysql2/promise');

async function check() {
  const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'XleHZxrmwY7fQAda',
    database: 'ordering_system',
    port: 3307,
    charset: 'utf8mb4'
  });

  const [dual] = await pool.query("SELECT value FROM settings WHERE `key`='dual_currency_enabled'");
  const [secondary] = await pool.query("SELECT value FROM settings WHERE `key`='secondary_currency_code'");
  const [menuStats] = await pool.query("SELECT COUNT(*) as total, SUM(active=0) as inactive, SUM(show_dual=1) as dual, SUM(secondary_currency_code='KHR') as khr FROM menus");
  const [menuSample] = await pool.query("SELECT id, name, active, show_dual, secondary_currency_code, currency_code FROM menus LIMIT 5");

  console.log('=== 设置验证 ===');
  console.log('双货币显示:', dual[0].value, dual[0].value === '1' ? '✓' : '✗');
  console.log('第二货币:', secondary[0].value, secondary[0].value === 'KHR' ? '✓' : '✗');
  console.log('');
  console.log('=== 菜品统计 ===');
  console.log('总菜品数:', menuStats[0].total);
  console.log('已下架(active=0):', menuStats[0].inactive, menuStats[0].inactive === menuStats[0].total ? '✓' : '✗');
  console.log('启用双币(show_dual=1):', menuStats[0].dual, menuStats[0].dual === menuStats[0].total ? '✓' : '✗');
  console.log('第二货币KHR:', menuStats[0].khr, menuStats[0].khr === menuStats[0].total ? '✓' : '✗');
  console.log('');
  console.log('=== 菜品样例 ===');
  menuSample.forEach(m => {
    console.log(`#${m.id} ${m.name}: active=${m.active}, show_dual=${m.show_dual}, currency=${m.currency_code}, secondary=${m.secondary_currency_code}`);
  });

  await pool.end();
}

check().catch(console.error);
