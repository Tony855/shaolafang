#!/bin/bash
# ============================================================
#  FoodFlow 部署后健康巡检脚本
#  用法: bash scripts/health-check.sh [BASE_URL]
# ============================================================

BASE="${1:-http://localhost:3000}"
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

echo "==========================================="
echo "  FoodFlow 健康巡检 - $BASE"
echo "==========================================="

echo ""
echo "=== 1. 服务健康 ==="
HEALTH=$(curl -sS "$BASE/api/health" 2>/dev/null)
check "GET /api/health 返回 ok" "1" "$(echo "$HEALTH" | grep -c '"ok":true')"

echo ""
echo "=== 2. 关键页面 HTTP ==="
for p in /login /admin /waiter /kitchen /cashier /super /; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$p" 2>/dev/null)
  check "$p 返回 200" "200" "$code"
done

echo ""
echo "=== 3. 静态资源 ==="
for u in \
  /languages.min.js \
  /assets/core.js \
  /assets/common.css \
  /assets/vendor/fontawesome/css/all.min.css \
  /pages/login.js \
  /pages/cashier.js \
  /pages/admin.js; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$u" 2>/dev/null)
  check "$u 返回 200" "200" "$code"
done

echo ""
echo "=== 4. 数据库连接 ==="
DB_CHECK=$(mysql -u root foodflow_system -N -e "SELECT 1" 2>/dev/null)
check "MySQL 连接正常" "1" "$DB_CHECK"

echo ""
echo "=== 5. 数据隔离（抽查）==="
# 检查是否有 merchant_id 和 store_id 不匹配的数据
MISMATCH=$(mysql -u root foodflow_system -N -e "
SELECT (
  (SELECT COUNT(*) FROM menus m JOIN stores s ON s.id=m.store_id WHERE m.merchant_id != s.merchant_id) +
  (SELECT COUNT(*) FROM tables t JOIN stores s ON s.id=t.store_id WHERE t.merchant_id != s.merchant_id) +
  (SELECT COUNT(*) FROM orders o JOIN stores s ON s.id=o.store_id WHERE o.merchant_id != s.merchant_id) +
  (SELECT COUNT(*) FROM printers p JOIN stores s ON s.id=p.store_id WHERE p.merchant_id != s.merchant_id) +
  (SELECT COUNT(*) FROM waiters w JOIN stores s ON s.id=w.store_id WHERE w.merchant_id != s.merchant_id)
) AS total;
" 2>/dev/null)
check "merchant_id 与 store_id 一致" "0" "$MISMATCH"

echo ""
echo "=== 6. 关键 API 冒烟 ==="
TOKEN=$(curl -sS -X POST "$BASE/api/admin/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' 2>/dev/null | grep -oP '"token":"\K[^"]+')
check "admin 登录成功" "yes" "$([ -n "$TOKEN" ] && echo yes || echo no)"

if [ -n "$TOKEN" ]; then
  for api in /api/menu /api/admin/menu /api/tables /api/orders /api/currencies; do
    code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$api" \
      -H "Authorization: Bearer $TOKEN" -H "X-Store-Id: 1" 2>/dev/null)
    check "GET $api 返回 200" "200" "$code"
  done
fi

echo ""
echo "=== 7. 401 拦截 ==="
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/admin/menu" 2>/dev/null)
check "无 token 请求被拦截（401）" "401" "$code"

echo ""
echo "==========================================="
echo "  结果汇总"
echo "==========================================="
echo "  通过: $PASS"
echo "  失败: $FAIL"
if [ $FAIL -eq 0 ]; then
  echo ""
  echo "  🎉 全部健康检查通过！"
  exit 0
else
  echo ""
  echo "  ⚠ 有 $FAIL 项失败，请检查"
  exit 1
fi
