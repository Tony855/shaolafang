#!/bin/bash
DB="foodflow_system"
PASS=0; FAIL=0; WARN=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN+1)); }

echo "=== 1. 业务表 merchant_id 与 store 归属一致 ==="
M=$(mysql -u root "$DB" -N -e "SELECT (
  (SELECT COUNT(*) FROM menus m JOIN stores s ON s.id=m.store_id WHERE m.merchant_id != s.merchant_id) +
  (SELECT COUNT(*) FROM tables t JOIN stores s ON s.id=t.store_id WHERE t.merchant_id != s.merchant_id) +
  (SELECT COUNT(*) FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.merchant_id != s.merchant_id) +
  (SELECT COUNT(*) FROM waiters w JOIN stores s ON s.id=w.store_id WHERE w.merchant_id != s.merchant_id) +
  (SELECT COUNT(*) FROM printers p JOIN stores s ON s.id=p.store_id WHERE p.merchant_id != s.merchant_id));")
[ "$M" = "0" ] && ok "merchant_id 与 store_id 一致" || bad "有 $M 条不一致"

echo ""
echo "=== 2. 订单号前缀隔离（代码 + 数据库）==="
C1=$(grep -c 'merchant_\${mid}_order_prefix_normal'  routes/admin-printers.js 2>/dev/null); C1=${C1:-0}
C2=$(grep -c 'merchant_\${_mid}_order_prefix_normal' routes/orders.js 2>/dev/null);         C2=${C2:-0}
if [ "$C1" -gt 0 ] && [ "$C2" -gt 0 ]; then ok "代码隔离 (admin-printers=$C1, orders=$C2)"; else bad "代码未隔离 (admin-printers=$C1, orders=$C2)"; fi
DBC=$(mysql -u root "$DB" -N -e "SELECT COUNT(*) FROM settings WHERE \`key\` LIKE 'merchant%order_prefix%';")
if [ "$DBC" -gt 0 ]; then ok "数据库有 $DBC 条商户级前缀 key"; else warn "数据库无商户级 key"; fi

echo ""
echo "=== 3. waiters.username 唯一约束 ==="
IDX=$(mysql -u root "$DB" -N -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA='$DB' AND TABLE_NAME='waiters' AND INDEX_NAME='unique_merchant_username';")
[ "$IDX" -ge 2 ] && ok "复合唯一 (merchant_id, username)" || bad "仍是全局唯一"

echo ""
echo "=== 4. 打印隔离（formatOrder 返回 store_id）==="
G=$(grep -c 'store_id: row.store_id' server/services/order.js 2>/dev/null); G=${G:-0}
[ "$G" -gt 0 ] && ok "formatOrder 已返回 store_id" || bad "formatOrder 缺 store_id"

echo ""
echo "=== 5. 收银员登录候选匹配 ==="
G=$(grep -c 'const candidates = \[\]' routes/cashier.js 2>/dev/null); G=${G:-0}
[ "$G" -gt 0 ] && ok "收银员登录已用候选+密码唯一匹配" || bad "收银员登录未改"

echo ""
echo "=== 结果 ==="
echo "  通过: $PASS  失败: $FAIL  警告: $WARN"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
