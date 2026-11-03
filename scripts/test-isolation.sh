#!/bin/bash
BASE="http://localhost:3000"
PASS=0
FAIL=0

check() {
  local desc="$1"; local expect="$2"; local actual="$3"
  if [ "$expect" = "$actual" ]; then
    echo "  ✅ $desc"
    PASS=$((PASS+1))
  else
    echo "  ❌ $desc  (期望 $expect, 实际 $actual)"
    FAIL=$((FAIL+1))
  fi
}

TS=$(date +%s | tail -c 6)
WAITER_TEST_PASSWORD=$(openssl rand -hex 16)
echo "=============== 创建测试商户 ==============="

CRED_FILE="${INIT_CRED_FILE:-/var/lib/foodflow/initial-credentials.txt}"
line=$(grep -m1 '^superAdmin: ' "$CRED_FILE" 2>/dev/null || true)
SUPER_USERNAME="${SUPER_USERNAME:-$(printf '%s' "$line" | sed -E 's/^[^:]+: ([^ ]+) \/ .*/\1/')}"
SUPER_PASSWORD="${SUPER_PASSWORD:-$(printf '%s' "$line" | sed -E 's/^[^:]+: [^ ]+ \/ //')}"
if [ -z "$SUPER_USERNAME" ] || [ -z "$SUPER_PASSWORD" ]; then
  echo "缺少超级管理员凭据：请设置 SUPER_USERNAME/SUPER_PASSWORD 或提供 $CRED_FILE"
  exit 1
fi
SUPER=$(printf '{"username":"%s","password":"%s"}' "$SUPER_USERNAME" "$SUPER_PASSWORD" | curl -sS -X POST "$BASE/api/super/login" \
  -H 'Content-Type: application/json' --data-binary @- | grep -oP '"token":"\K[^"]+')

# 创建商户 A 和 B
for label in A B; do
  R=$(curl -sS -X POST "$BASE/api/super/merchants" \
    -H "Authorization: Bearer $SUPER" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"ISO_TEST_$label$TS\",\"code\":\"ISO$label$TS\",\"username\":\"iso$label$TS\",\"password\":\"iso$label$TS\",\"max_stores\":1}")
  eval "ADMIN_$label=\$(echo \$R | grep -oP '\"adminUsername\":\"\\K[^\"]+')"
  eval "MID_$label=\$(echo \$R | grep -oP '\"id\":\\K[0-9]+' | head -1)"
done
echo "  商户 A: $ADMIN_A (id=$MID_A)"
echo "  商户 B: $ADMIN_B (id=$MID_B)"

echo ""
echo "=============== 双方登录 ==============="

# 密码是 isoA<TS>。
T_A=$(curl -sS -X POST "$BASE/api/admin/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_A\",\"password\":\"isoA$TS\"}" | grep -oP '"token":"\K[^"]+')
T_B=$(curl -sS -X POST "$BASE/api/admin/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_B\",\"password\":\"isoB$TS\"}" | grep -oP '"token":"\K[^"]+')

check "商户 A 登录" "yes" "$([ -n "$T_A" ] && echo yes || echo no)"
check "商户 B 登录" "yes" "$([ -n "$T_B" ] && echo yes || echo no)"

# 取各自的 store_id
S_A=$(curl -sS "$BASE/api/admin/stores" -H "Authorization: Bearer $T_A" | grep -oP '"id":\K[0-9]+' | head -1)
S_B=$(curl -sS "$BASE/api/admin/stores" -H "Authorization: Bearer $T_B" | grep -oP '"id":\K[0-9]+' | head -1)
echo "  商户 A store_id=$S_A"
echo "  商户 B store_id=$S_B"

echo ""
echo "=============== 商户 A 创建业务数据 ==============="

# A 创建分类
curl -sS -X POST "$BASE/api/menu-categories" \
  -H "Authorization: Bearer $T_A" -H "X-Store-Id: $S_A" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"A分类$TS\"}" > /dev/null

# A 创建菜单
curl -sS -X POST "$BASE/api/menu" \
  -H "Authorization: Bearer $T_A" -H "X-Store-Id: $S_A" \
  -F "name=A菜单$TS" -F "price=55" -F "category=A分类$TS" \
  -F "emoji=🍜" -F "currency_code=USD" > /dev/null

# A 创建桌号
curl -sS -X POST "$BASE/api/tables" \
  -H "Authorization: Bearer $T_A" -H "X-Store-Id: $S_A" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"ATABLE$TS\"}" > /dev/null

# A 创建打印机
curl -sS -X POST "$BASE/api/admin/printers" \
  -H "Authorization: Bearer $T_A" -H "X-Store-Id: $S_A" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"APRINTER$TS\",\"type\":\"network\",\"ip_address\":\"10.0.0.10\"}" > /dev/null

# A 创建服务员
curl -sS -X POST "$BASE/api/admin/waiters" \
  -H "Authorization: Bearer $T_A" -H "X-Store-Id: $S_A" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"wA$TS\",\"password\":\"123456\",\"display_name\":\"A服务员\"}" > /dev/null

echo "  ✓ 商户 A 已创建：分类/菜单/桌号/打印机/服务员"

echo ""
echo "=============== 核心隔离测试 ==============="

# 1. B 能否看到 A 的菜单？
MENU_B=$(curl -sS "$BASE/api/admin/menu" -H "Authorization: Bearer $T_B" -H "X-Store-Id: $S_B")
check "商户 B 看不到商户 A 的菜单" "0" "$(echo "$MENU_B" | grep -c "A菜单$TS")"

# 2. B 能否看到 A 的打印机？
PRINT_B=$(curl -sS "$BASE/api/admin/printers" -H "Authorization: Bearer $T_B" -H "X-Store-Id: $S_B")
check "商户 B 看不到商户 A 的打印机" "0" "$(echo "$PRINT_B" | grep -c "APRINTER$TS")"

# 3. B 能否看到 A 的服务员？
WAIT_B=$(curl -sS "$BASE/api/admin/waiters" -H "Authorization: Bearer $T_B" -H "X-Store-Id: $S_B")
check "商户 B 看不到商户 A 的服务员" "0" "$(echo "$WAIT_B" | grep -c "wA$TS")"

# 4. B 能否看到 A 的分类？
CAT_B=$(curl -sS "$BASE/api/menu-categories" -H "Authorization: Bearer $T_B" -H "X-Store-Id: $S_B")
check "商户 B 看不到商户 A 的分类" "0" "$(echo "$CAT_B" | grep -c "A分类$TS")"

# 5. B 用 A 的 store_id 请求（跨商户越权）
CROSS=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/admin/menu" \
  -H "Authorization: Bearer $T_B" -H "X-Store-Id: $S_A")
check "商户 B 伪造 X-Store-Id=$S_A 被拒绝（401）" "401" "$CROSS"

# 6. 数据库层面：A 的数据是否 merchant_id 正确
DB_CHECK=$(mysql -u root foodflow_system -N -e "
SELECT COUNT(*) FROM menus WHERE name='A菜单$TS' AND merchant_id=$MID_A;
" 2>/dev/null)
check "A 的菜单 merchant_id 正确" "1" "$DB_CHECK"

DB_CHECK2=$(mysql -u root foodflow_system -N -e "
SELECT COUNT(*) FROM printers WHERE name='APRINTER$TS' AND merchant_id=$MID_A;
" 2>/dev/null)
check "A 的打印机 merchant_id 正确" "1" "$DB_CHECK2"

DB_CHECK3=$(mysql -u root foodflow_system -N -e "
SELECT COUNT(*) FROM waiters WHERE username='wA$TS' AND merchant_id=$MID_A;
" 2>/dev/null)
check "A 的服务员 merchant_id 正确" "1" "$DB_CHECK3"

echo ""
echo "=============== 顾客扫码下单 ==============="

# 通过 A 桌号的 qr_token 创建会话
QR_TOKEN=$(mysql -u root foodflow_system -N -e "
SELECT qr_token FROM tables WHERE name='ATABLE$TS' AND store_id=$S_A;
" 2>/dev/null)

if [ -n "$QR_TOKEN" ]; then
  SESSION_RESP=$(curl -sS "$BASE/api/public/table-token/$QR_TOKEN")
  SESSION_TOKEN=$(echo "$SESSION_RESP" | grep -oP '"sessionToken":"\K[^"]+')
  CUSTOMER_TOKEN=$(echo "$SESSION_RESP" | grep -oP '"customerToken":"\K[^"]+')
  echo "  会话建立: sessionToken=${SESSION_TOKEN:0:12}..."
  
  # 下单
  MENU_ID=$(mysql -u root foodflow_system -N -e "
    SELECT id FROM menus WHERE name='A菜单$TS' LIMIT 1;
  " 2>/dev/null)
  
  if [ -n "$MENU_ID" ]; then
    ORDER_RESP=$(curl -sS -X POST "$BASE/api/orders" \
      -H 'Content-Type: application/json' \
      -d "{\"table\":\"ATABLE$TS\",\"sessionToken\":\"$SESSION_TOKEN\",\"customerToken\":\"$CUSTOMER_TOKEN\",\"items\":[{\"id\":$MENU_ID,\"quantity\":1}]}")
    ORDER_ID=$(echo "$ORDER_RESP" | grep -oP '"orderId":\K[0-9]+')
    echo "  订单已创建: id=$ORDER_ID"
    
    # 订单的 merchant_id 是否对
    DB_ORDER=$(mysql -u root foodflow_system -N -e "
      SELECT merchant_id FROM orders WHERE id=$ORDER_ID;
    " 2>/dev/null)
    check "顾客订单的 merchant_id 正确" "$MID_A" "$DB_ORDER"
    
    # B 登录后能否看到 A 的订单？
    ORDERS_B=$(curl -sS "$BASE/api/orders" -H "Authorization: Bearer $T_B" -H "X-Store-Id: $S_B")
    check "商户 B 看不到商户 A 的订单" "0" "$(echo "$ORDERS_B" | grep -c "$ORDER_ID")"
  fi
fi

echo ""
echo "=============== 催单隔离 ==============="

if [ -n "$ORDER_ID" ]; then
  curl -sS -X POST "$BASE/api/orders/$ORDER_ID/urge" \
    -H 'Content-Type: application/json' -d '{}' > /dev/null
  
  CALLS_B=$(curl -sS "$BASE/api/waiter-calls" \
    -H "Authorization: Bearer $T_B" -H "X-Store-Id: $S_B")
  check "商户 B 看不到商户 A 的催单" "0" "$(echo "$CALLS_B" | grep -c "订单 #$ORDER_ID")"
fi

echo ""
echo "=============== 清理测试数据 ==============="

if [ -n "${MID_A:-}" ] && [ -n "${MID_B:-}" ] && [ -n "${S_A:-}" ] && [ -n "${S_B:-}" ]; then
mysql -u root foodflow_system -e "
DELETE FROM orders WHERE store_id IN ($S_A, $S_B);
DELETE FROM waiter_calls WHERE store_id IN ($S_A, $S_B);
DELETE FROM scan_sessions WHERE store_id IN ($S_A, $S_B);
DELETE FROM waiter_sessions WHERE waiter_id IN (SELECT id FROM waiters WHERE merchant_id IN ($MID_A, $MID_B));
DELETE FROM cashier_sessions WHERE store_id IN ($S_A, $S_B);
DELETE FROM admin_sessions WHERE admin_id IN (SELECT id FROM merchant_admins WHERE merchant_id IN ($MID_A, $MID_B));
DELETE FROM login_logs WHERE username IN ('$ADMIN_A', '$ADMIN_B') OR username LIKE 'wA$TS';
DELETE FROM audit_logs WHERE (target_type='merchant' AND target_id IN ($MID_A, $MID_B)) OR (actor_type='merchant_admin' AND actor_id IN (SELECT id FROM merchant_admins WHERE merchant_id IN ($MID_A, $MID_B)));
DELETE FROM reservations WHERE store_id IN ($S_A, $S_B);
DELETE FROM printers WHERE store_id IN ($S_A, $S_B);
DELETE FROM waiters WHERE store_id IN ($S_A, $S_B);
DELETE FROM menus WHERE store_id IN ($S_A, $S_B);
DELETE FROM menu_categories WHERE store_id IN ($S_A, $S_B);
DELETE FROM tables WHERE store_id IN ($S_A, $S_B);
DELETE FROM currencies WHERE merchant_id IN ($MID_A, $MID_B);
DELETE FROM settings WHERE `key` LIKE 'store_${S_A}_%' OR `key` LIKE 'store_${S_B}_%' OR `key` LIKE 'merchant_${MID_A}_%' OR `key` LIKE 'merchant_${MID_B}_%' OR `key` IN ('cashiers_${S_A}', 'cashiers_${S_B}');
DELETE FROM merchant_admins WHERE merchant_id IN ($MID_A, $MID_B);
DELETE FROM stores WHERE merchant_id IN ($MID_A, $MID_B);
DELETE FROM merchants WHERE id IN ($MID_A, $MID_B);
" 2>/dev/null
fi
echo "  ✓ 已清理"

echo ""
echo "=============== 结果汇总 ==============="
echo "  通过: $PASS"
echo "  失败: $FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo ""
  echo "  🎉 全部隔离测试通过！"
  exit 0
else
  echo ""
  echo "  ⚠ 有 $FAIL 项失败，需排查"
  exit 1
fi
