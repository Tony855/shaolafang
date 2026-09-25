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
  const [row]=await c.execute(\"SELECT value FROM settings WHERE \`key\`='qr_session_timeout'\");
  console.log('数据库里qr_session_timeout值：', row[0] ? row[0].value : '默认45分钟');
  process.exit(0);
})()
"
EOF
