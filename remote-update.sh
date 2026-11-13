#!/usr/bin/env bash
# FoodFlow remote update: serialized, clean-worktree-only, transactional rollback.
# Usage: GIT_VERSION=main bash remote-update.sh
set -Eeuo pipefail

SCRIPT_DIR="${FF_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$SCRIPT_DIR"
# shellcheck source=scripts/lib/system-deps.sh
source "$SCRIPT_DIR/scripts/lib/system-deps.sh"
# shellcheck source=scripts/lib/deploy-safety.sh
SAFETY_LIB="${FF_DEPLOY_SAFETY_LIB:-$SCRIPT_DIR/scripts/lib/deploy-safety.sh}"
source "$SAFETY_LIB"
ff_enable_error_trap

if [ "$EUID" -ne 0 ]; then
  echo "[ERROR] 请使用 root 权限运行 remote-update.sh" >&2
  exit 1
fi
ff_acquire_deploy_lock

for cmd in git npm systemctl curl node; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "[ERROR] 缺少命令: $cmd" >&2
    exit 1
  }
done

SKIP_GIT_UPDATE="${SKIP_GIT_UPDATE:-0}"
GIT_VERSION="${GIT_VERSION:-main}"
OLD_SHA=""
TARGET_SHA=""
SOURCE_CHANGED=0
DEPENDENCIES_SWAPPED=0
UPDATE_OK=0
STAGE=""
OLD_NODE_MODULES=""

rollback_update() {
  local rc=$?
  if [ "$UPDATE_OK" = "1" ]; then
    [ -z "$STAGE" ] || rm -rf "$STAGE"
    return
  fi
  trap - EXIT
  echo "[ERROR] 升级未完成（退出码 $rc），执行自动回滚..." >&2
  if [ "$DEPENDENCIES_SWAPPED" = "1" ]; then
    rm -rf "$SCRIPT_DIR/node_modules"
    if [ -d "$OLD_NODE_MODULES" ]; then
      mv "$OLD_NODE_MODULES" "$SCRIPT_DIR/node_modules" || echo "[CRITICAL] 旧 node_modules 恢复失败：$OLD_NODE_MODULES" >&2
    fi
  fi
  if [ "$SOURCE_CHANGED" = "1" ] && [ -n "$OLD_SHA" ]; then
    git reset --hard "$OLD_SHA" || echo "[CRITICAL] 源码回滚失败，请手动恢复到 $OLD_SHA" >&2
  fi
  if systemctl cat foodflow.service >/dev/null 2>&1; then
    systemctl restart foodflow.service || echo "[CRITICAL] 旧版本服务重启失败，请检查 journalctl -u foodflow" >&2
  fi
  [ -z "$STAGE" ] || rm -rf "$STAGE"
  exit "$rc"
}
trap rollback_update EXIT

if [ "$SKIP_GIT_UPDATE" != "1" ]; then
  [ -d .git ] || { echo "[ERROR] 当前目录不是 Git 仓库: $SCRIPT_DIR" >&2; exit 1; }
  ff_require_clean_git_worktree
  OLD_SHA="$(git rev-parse HEAD)"
  STAGE="$(mktemp -d "$SCRIPT_DIR/.foodflow-update.XXXXXX")"
  OLD_NODE_MODULES="$STAGE/node_modules.previous"
  echo "[INFO] 获取目标版本 $GIT_VERSION..."
  git fetch --no-tags origin "$GIT_VERSION"
  TARGET_SHA="$(git rev-parse FETCH_HEAD)"
  [ -n "$TARGET_SHA" ] || { echo "[ERROR] 无法解析目标提交。" >&2; exit 1; }
  if [ "$TARGET_SHA" = "$OLD_SHA" ]; then
    echo "[INFO] 当前源码已是目标版本 $TARGET_SHA"
  else
    SOURCE_CHANGED=1
    git reset --hard "$TARGET_SHA"
  fi
else
  STAGE="$(mktemp -d "$SCRIPT_DIR/.foodflow-update.XXXXXX")"
  OLD_NODE_MODULES="$STAGE/node_modules.previous"
  echo "[INFO] SKIP_GIT_UPDATE=1，保留当前源码"
fi

ff_ensure_node
[ -f package.json ] && [ -f package-lock.json ] || {
  echo "[ERROR] 缺少 package.json 或 package-lock.json，拒绝更新运行依赖" >&2
  exit 1
}
cp package.json package-lock.json "$STAGE/"
echo "[INFO] 在隔离目录安装锁定的生产依赖..."
(cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund)

if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo "[ERROR] 当前 node_modules 不存在；拒绝进行不可回滚的生产升级。" >&2
  exit 1
fi
mv "$SCRIPT_DIR/node_modules" "$OLD_NODE_MODULES"
DEPENDENCIES_SWAPPED=1
mv "$STAGE/node_modules" "$SCRIPT_DIR/node_modules"

if ! systemctl cat foodflow.service >/dev/null 2>&1; then
  if [ "${FF_ALLOW_NO_SERVICE:-0}" = "1" ]; then
    echo "[WARN] foodflow.service 未启用；FF_ALLOW_NO_SERVICE=1，跳过服务健康验证。"
    UPDATE_OK=1
    rm -rf "$STAGE"
    trap - EXIT
    exit 0
  fi
  echo "[ERROR] 未发现已启用的 foodflow.service；生产更新默认要求服务与健康检查。" >&2
  exit 1
fi

PORT="$(sed -n 's/^PORT=//p' "$SCRIPT_DIR/.env" 2>/dev/null | tail -n 1)"
PORT="${PORT:-3000}"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || {
  echo "[ERROR] .env 中 PORT 无效。" >&2
  exit 1
}

echo "[INFO] 重启 foodflow 并验证应用与数据库就绪..."
systemctl restart foodflow.service
ff_wait_for_health "$PORT" "${FF_HEALTH_ATTEMPTS:-30}"

UPDATE_OK=1
rm -rf "$STAGE"
trap - EXIT
echo "[OK] 更新完成：源码与生产依赖已切换，服务和数据库健康检查通过。"
