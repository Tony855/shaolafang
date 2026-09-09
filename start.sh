#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 18+ is required"; exit 1; }
if [ ! -d node_modules ]; then npm install --omit=dev; fi
export NODE_ENV="${NODE_ENV:-production}"
# 统一使用 PORT（与 server.js / .env / systemd 保持一致）；
# 兼容旧脚本可能仍传入的 APP_PORT。
export PORT="${PORT:-${APP_PORT:-3000}}"
echo "Starting ordering system on port ${PORT}..."
exec node server.js
