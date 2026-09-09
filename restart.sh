#!/usr/bin/env bash
set -euo pipefail
# 统一使用 PORT（与 server.js / .env / systemd 保持一致）；兼容旧的 APP_PORT。
PORT="${PORT:-${APP_PORT:-3000}}"
echo "Stopping service on port ${PORT}..."
PID=""
if command -v lsof >/dev/null 2>&1; then
  PID=$(lsof -t -i:"${PORT}" 2>/dev/null || true)
elif command -v fuser >/dev/null 2>&1; then
  PID=$(fuser "${PORT}/tcp" 2>/dev/null || true)
elif command -v ss >/dev/null 2>&1; then
  PID=$(ss -lntp "sport = :${PORT}" | grep -oP 'pid=\K[0-9]+' | head -n 1 || true)
fi
if [ -n "$PID" ]; then
    echo "找到进程 PID: ${PID}，正在终止..."
    kill -9 $PID 2>/dev/null || true
    sleep 1
    echo "旧进程已清理。"
else
    echo "未发现占用 ${PORT} 端口的进程。"
fi

PORT="${PORT}" nohup bash "$(dirname "$0")/start.sh" > server.log 2>&1 &
echo "✅ 服务已在后台启动，日志：server.log"
exit 0
