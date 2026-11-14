#!/usr/bin/env bash
# Minimal post-install check: configuration, service, database readiness, initial credentials.
set -Eeuo pipefail

APP_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$APP_DIR/.env"
SERVICE_NAME="${SERVICE_NAME:-foodflow}"
CREDENTIALS_FILE="${INIT_CRED_FILE:-/var/lib/foodflow/initial-credentials.txt}"

# Reuse the bounded readiness probe used by all deployment entrypoints.
# shellcheck source=scripts/lib/deploy-safety.sh
source "$APP_DIR/scripts/lib/deploy-safety.sh"

ok()   { printf '[OK] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
fail() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || fail "未找到配置文件：$ENV_FILE"
# Match server/config/env.js: DB_HOST, DB_USER and DB_PASSWORD have
# runtime defaults (localhost, root and empty password respectively).
# DB_DATABASE is the only database setting that the application requires.
if ! grep -Eq '^DB_DATABASE=.+$' "$ENV_FILE"; then
  fail ".env 缺少必填项：DB_DATABASE（不会显示任何密钥内容）"
fi
if ! grep -Eq '^DB_HOST=.+$' "$ENV_FILE"; then
  ok "DB_HOST 未显式设置，将使用应用默认值 localhost"
fi
ok "数据库配置通过（密钥内容已隐藏）"

PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1)"
PORT="${PORT:-3000}"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "PORT 配置无效"
ok "应用端口配置有效：$PORT"

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet "$SERVICE_NAME" || fail "$SERVICE_NAME 服务未处于 active 状态"
  ok "$SERVICE_NAME 服务正在运行"
else
  warn "systemctl 不可用，跳过服务状态检查"
fi

if ! ff_wait_for_health "$PORT" "${FF_HEALTH_ATTEMPTS:-30}"; then
  fail "应用或数据库健康检查失败；请查看 journalctl -u $SERVICE_NAME"
fi
ok "应用与数据库健康检查通过"

if [ -f "$CREDENTIALS_FILE" ]; then
  if find "$CREDENTIALS_FILE" -maxdepth 0 -perm /077 -print -quit | grep -q .; then
    fail "初始凭据文件权限过宽，请执行 chmod 600 '$CREDENTIALS_FILE'"
  fi
  grep -q '^superAdmin:' "$CREDENTIALS_FILE" || warn "凭据文件存在，但未发现新建超级管理员的凭据记录（可能已存在管理员账号）"
  ok "初始凭据文件存在且未向组/其他用户开放：$CREDENTIALS_FILE"
else
  warn "未发现初始凭据文件：$CREDENTIALS_FILE；如果是全新数据库，请检查首次初始化日志"
fi

printf '\n首次登录入口：\n'
printf '  平台超级管理员：/super/login\n'
printf '  商户管理员：    /login\n'
printf '初始凭据文件：%s\n' "$CREDENTIALS_FILE"
printf '请首次登录后立即修改初始密码；本检查不会读取或打印密码。\n'
