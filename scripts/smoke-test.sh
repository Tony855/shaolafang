#!/bin/bash
# FoodFlow 全站冒烟测试 v2（修了 $[0] 展开 + 顺序）
BASE="${1:-http://localhost:3000}"
PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
step() { echo ""; echo "───── $1 ─────"; }

# 用单引号包裹 SQL，避免 $ 被展开
sql() {
  mysql -u root foodflow_system -N -e "$1" 2>/dev/null
}

TS=$(date +%s | tail -c 7)

step "0. 准备测试数据"
STORE_ID=1
MENU_ID=$(sql "SELECT id FROM menus WHERE store_id=$STORE_ID LIMIT 1;")
[ -z "$MENU_ID" ] && { bad "无菜品"; exit 1; }
ok "菜品 ID=$MENU_ID"

QR=$(sql "SELECT qr_token FROM tables WHERE store_id=$STORE_ID AND qr_token IS NOT NULL LIMIT 1;")
[ -z "$QR" ] && { bad "无桌"; exit 1; }
TABLE_NAME=$(sql "SELECT name FROM tables WHERE qr_token='$QR';")
ok "桌号=$TABLE_NAME"

step "1. 顾客扫码"
SESSION_RESP=$(curl -sS "$BASE/api/public/table-token/$QR")
SESSION_TOKEN=$(echo "$SESSION_RESP" | grep -oP '"sessionToken":"\K[^"]+')
CUSTOMER_TOKEN=$(echo "$SESSION_RESP" | grep -oP '"customerToken":"\K[^"]+')
[ -n "$SESSION_TOKEN" ] && ok "扫码成功" || { bad "扫码失败"; exit 1; }

step "2. 顾客下单"
ORDER_RESP=$(curl -sS -X POST "$BASE/api/orders" -H 'Content-Type: application/json' \
  -d "{\"table\":\"$TABLE_NAME\",\"sessionToken\":\"$SESSION_TOKEN\",\"customerToken\":\"$CUSTOMER_TOKEN\",\"items\":[{\"id\":$MENU_ID,\"quantity\":1}]}")
ORDER_ID=$(echo "$ORDER_RESP" | grep -oP '"orderId":\K[0-9]+')
[ -n "$ORDER_ID" ] && ok "订单 #$ORDER_ID" || { bad "下单失败: $ORDER_RESP"; exit 1; }

step "3. 初始状态 pending"
S=$(sql "SELECT status FROM orders WHERE id=$ORDER_ID;")
[ "$S" = "pending" ] && ok "status=pending" || bad "status=$S"

step "4. 后厨标记菜品完成"
WT=$(sql "SELECT token FROM waiter_sessions WHERE expires_at > NOW() ORDER BY id DESC LIMIT 1;")
if [ -z "$WT" ]; then
  # 没登录过 waiter，用收银 token 也能改状态（admin 权限）
  WT=""
fi
PUT_RESP=$(curl -sS -X PUT "$BASE/api/orders/$ORDER_ID/items/0" \
  -H "X-Waiter-Token: $WT" \
  -H 'Content-Type: application/json' \
  -d '{"itemStatus":"done"}')
ITEM_STATUS=$(echo "$PUT_RESP" | grep -oP '"itemStatus":"\K[^"]+' | head -1)
[ "$ITEM_STATUS" = "done" ] && ok "itemStatus=done" || bad "itemStatus=$ITEM_STATUS  (响应: ${PUT_RESP:0:100})"

step "5. 顾客催单（订单还是 pending）"
URGE_RESP=$(curl -sS -X POST "$BASE/api/orders/$ORDER_ID/urge" \
  -H 'Content-Type: application/json' \
  -d "{\"sessionToken\":\"$SESSION_TOKEN\"}")
CNT=$(sql "SELECT COUNT(*) FROM waiter_calls WHERE message LIKE '%#$ORDER_ID%';")
if [ "$CNT" -gt 0 ]; then
  ok "waiter_calls 写入 $CNT 条"
else
  bad "未写入  (响应: ${URGE_RESP:0:150})"
fi

step "6. 收银员登录"
CASHIER_TOKEN=$(curl -sS -X POST "$BASE/api/cashier/login" -H 'Content-Type: application/json' \
  -d '{"username":"cashier","password":"123456"}' | grep -oP '"token":"\K[^"]+')
if [ -n "$CASHIER_TOKEN" ]; then
  ok "登录成功"
  CASHIER_OK=1
else
  bad "收银员登录失败"
  CASHIER_OK=0
fi

step "7. 结算订单"
if [ "$CASHIER_OK" = "1" ]; then
  curl -sS -X PUT "$BASE/api/cashier/orders/$ORDER_ID/settle" \
    -H "X-Cashier-Token: $CASHIER_TOKEN" -H 'Content-Type: application/json' \
    -d '{"pay_method":"cash","cash_received":999,"cash_change":0}' > /dev/null
fi
S=$(sql "SELECT status FROM orders WHERE id=$ORDER_ID;")
[ "$S" = "done" ] && ok "status=done" || bad "status=$S"

step "8. 退款订单"
if [ "$CASHIER_OK" = "1" ]; then
  curl -sS -X PUT "$BASE/api/cashier/orders/$ORDER_ID/refund" \
    -H "X-Cashier-Token: $CASHIER_TOKEN" -H 'Content-Type: application/json' \
    -d '{"amount":0,"reason":"smoke"}' > /dev/null
fi
S=$(sql "SELECT status FROM orders WHERE id=$ORDER_ID;")
[ "$S" = "refunded" ] && ok "status=refunded" || bad "status=$S"

step "9. 顾客查订单（结算后 session 应失效）"
# 本次会话加的"结算后清 session"逻辑 → 查不到是**预期行为**
if curl -sS "$BASE/api/public/table-session/$SESSION_TOKEN/orders?ct=$CUSTOMER_TOKEN" | grep -q "\"id\":$ORDER_ID"; then
  bad "结算后 session 仍能查到订单（应失效）"
else
  ok "结算后 session 已失效（预期）"
fi

step "10. 数据隔离"
MID=$(sql "SELECT merchant_id FROM orders WHERE id=$ORDER_ID;")
SID=$(sql "SELECT store_id FROM orders WHERE id=$ORDER_ID;")
SMID=$(sql "SELECT merchant_id FROM stores WHERE id=$SID;")
[ "$MID" = "$SMID" ] && ok "merchant_id 一致" || bad "merchant_id $MID ≠ $SMID"

step "11. 清理"
sql "DELETE FROM waiter_calls WHERE message LIKE '%#$ORDER_ID%'; DELETE FROM orders WHERE id=$ORDER_ID; DELETE FROM scan_sessions WHERE token='$SESSION_TOKEN';"
ok "已清理 #$ORDER_ID"

echo ""
echo "══════════════════════════════════════════════"
echo "  通过: $PASS    失败: $FAIL"
[ $FAIL -eq 0 ] && echo "  🎉 全部通过" || echo "  ⚠️  $FAIL 项失败"
echo "══════════════════════════════════════════════"
