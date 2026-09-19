const fs = require('fs');
const p = 'C:/Users/DONGFeng/Downloads/shaolafang/server.js';
let t = fs.readFileSync(p, 'utf8');
// /cashier 路由加版本查询参数支持
t = t.replace(
  "app.get('/cashier', (req, res) => {\n  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');\n  res.set('Pragma', 'no-cache');\n  res.set('Expires', '0');\n  res.sendFile(path.join(__dirname, 'cashier.html'));\n});",
  "app.get('/cashier', (req, res) => {\n  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');\n  res.set('Pragma', 'no-cache');\n  res.set('Expires', '0');\n  res.sendFile(path.join(__dirname, 'cashier.html'), { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } });\n});"
);
fs.writeFileSync(p, t, 'utf8');
console.log('done');
