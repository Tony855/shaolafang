#!/bin/bash
ssh -o StrictHostKeyChecking=no -i ~/serverkey.pem -p 20959 root@foodflow.v2net.cc << 'EOF'
mysql -u foodflow -p'rYTAYpRWVVIFslJr' ordering_system -e "
INSERT INTO scan_sessions (table_name, token, expires_at, created_at, store_id) VALUES ('B05', 'qr_b05_final_test', DATE_ADD(NOW(), INTERVAL 2 HOUR), NOW(), 1);
SELECT CONCAT('B05链接：https://foodflow.v2net.cc/?session=qr_b05_final_test') AS link;
"
EOF
