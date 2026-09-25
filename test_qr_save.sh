#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
cd /var/www/foodflow
set -a
. ./.env
set +a
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME});
  // 先查原来的值
  const [oldRow]=await c.execute(\"SELECT value FROM settings WHERE \`key\`='qr_session_timeout'\");
  console.log('修改前qr_session_timeout：', oldRow[0] ? oldRow[0].value : '无');
  // 直接修改成120
  await c.execute(\"INSERT INTO settings (\`key\`, value) VALUES ('qr_session_timeout', '120') ON DUPLICATE KEY UPDATE value='120'\");
  // 再查
  const [newRow]=await c.execute(\"SELECT value FROM settings WHERE \`key\`='qr_session_timeout'\");
  console.log('修改后qr_session_timeout：', newRow[0].value);
  process.exit(0);
})()
"
EOF
