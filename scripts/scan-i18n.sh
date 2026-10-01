#!/bin/bash
# 扫描 admin 页面缺失的 i18n key
cd "$(dirname "$0")/.."

echo "════════ 1. HTML/JS 里被引用的所有 i18n key ════════"
KEYS=$(grep -rhoE "data-i18n(-placeholder|-title)?=\"[a-zA-Z0-9_]+\"|tAdmin\('[a-zA-Z0-9_]+'\)|L\('[a-zA-Z0-9_]+'\)" \
  admin.html pages/admin*.js pages/admin/*.js 2>/dev/null \
  | grep -oE "'[a-zA-Z0-9_]+'|\"[a-zA-Z0-9_]+\"" \
  | tr -d "'\"" | sort -u)

echo "共 $(echo "$KEYS" | wc -l) 个 key"
echo ""

echo "════════ 2. zh.json 里已有的 key ════════"
ZH_KEYS=$(python3 -c "
import json
d = json.load(open('locales/zh.json'))
def walk(o, p=''):
    for k,v in o.items():
        if isinstance(v, dict): walk(v, p+k+'.')
        else: print(k)
walk(d)
")
echo "共 $(echo "$ZH_KEYS" | wc -l) 个 key"
echo ""

echo "════════ 3. 缺失的 key（在代码里用了但语言包没有） ════════"
MISSING=$(comm -23 <(echo "$KEYS" | sort -u) <(echo "$ZH_KEYS" | sort -u))
if [ -z "$MISSING" ]; then
  echo "✅ 无缺失"
else
  echo "$MISSING" | while read k; do
    [ -z "$k" ] && continue
    echo "  ❌ $k"
    grep -n "$k" admin.html pages/admin*.js pages/admin/*.js 2>/dev/null | head -2 | sed 's/^/       /'
  done
fi
