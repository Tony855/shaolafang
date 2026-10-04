#!/bin/bash
# 给所有 HTML 里指定资源的 ?v=xxx 刷成当前时间戳
# 用法:
#   bash scripts/bump-version.sh              # 刷所有 assets/pages 引用
#   bash scripts/bump-version.sh core.js      # 只刷 core.js
#   bash scripts/bump-version.sh admin-bundle # 只刷 admin-bundle.js

cd "$(dirname "$0")/.."
TS=$(date +%s)

if [ -n "$1" ]; then
    echo "刷新 [$1] 的版本号 -> $TS"
    for f in *.html; do
        sed -i "s|$1\.js?v=[0-9]*|$1.js?v=$TS|g" "$f"
        sed -i "s|$1\.css?v=[0-9]*|$1.css?v=$TS|g" "$f"
    done
else
    echo "刷新所有 assets/pages/languages 引用 -> $TS"
    for f in *.html; do
        # 刷 assets/*.js, pages/*.js, assets/*.css, modules/*.js, languages.min.js
        sed -i -E "s|(assets/[a-zA-Z0-9_/\-]+\.(js\|css))\?v=[0-9]+|\1?v=$TS|g" "$f"
        sed -i -E "s|(pages/[a-zA-Z0-9_/\-]+\.js)\?v=[0-9]+|\1?v=$TS|g" "$f"
        sed -i -E "s|(languages\.min\.js)\?v=[0-9]+|\1?v=$TS|g" "$f"
    done
fi

echo "✅ 完成，时间戳: $TS"
grep -oh '?v=[0-9]*' *.html | sort -u | head -5
