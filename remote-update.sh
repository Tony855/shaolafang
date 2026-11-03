#!/usr/bin/env bash
# FoodFlow 远程更新脚本
# 自动定位到脚本所在目录，按指定分支/标签更新源码和锁定依赖，并在失败时回滚。
# 用法: GIT_VERSION=main bash remote-update.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
echo "[INFO] 工作目录: $SCRIPT_DIR"

for cmd in git npm systemctl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[ERROR] 缺少命令: $cmd"
    exit 1
  fi
done

SKIP_GIT_UPDATE="${SKIP_GIT_UPDATE:-0}"
GIT_VERSION="${GIT_VERSION:-main}"
OLD_SHA=""
if [ "$SKIP_GIT_UPDATE" != "1" ]; then
  if [ ! -d ".git" ]; then
    echo "[ERROR] 当前目录不是 git 仓库: $SCRIPT_DIR"
    exit 1
  fi
  OLD_SHA="$(git rev-parse HEAD)"
fi
TS="$(date +%Y%m%d%H%M%S)"
STAGE="$SCRIPT_DIR/.node_modules-stage-$TS"
BACKUP="$SCRIPT_DIR/.node_modules-backup-$TS"

if [ "$SKIP_GIT_UPDATE" != "1" ]; then
  echo "[INFO] 拉取 $GIT_VERSION..."
  git fetch origin "$GIT_VERSION"
  git reset --hard FETCH_HEAD
else
  echo "[INFO] SKIP_GIT_UPDATE=1，保留部署目录当前源码"
fi

if [ ! -f package.json ] || [ ! -f package-lock.json ]; then
  echo "[ERROR] 缺少 package.json 或 package-lock.json，拒绝更新运行依赖"
  git reset --hard "$OLD_SHA"
  exit 1
fi

mkdir -p "$STAGE"
cp package.json package-lock.json "$STAGE/"
echo "[INFO] 在独立目录安装锁定的生产依赖..."
if ! (cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund); then
  rm -rf "$STAGE"
  git reset --hard "$OLD_SHA"
  echo "[ERROR] 依赖安装失败，已回滚源码，现有 node_modules 未变更"
  exit 1
fi

if [ -d node_modules ]; then
  mv node_modules "$BACKUP"
fi
if ! mv "$STAGE/node_modules" node_modules; then
  [ -d "$BACKUP" ] && mv "$BACKUP" node_modules
  rm -rf "$STAGE"
  git reset --hard "$OLD_SHA"
  echo "[ERROR] 切换依赖目录失败，已恢复旧依赖和源码"
  exit 1
fi
rm -rf "$STAGE"

if systemctl list-unit-files | grep -q "^foodflow.service"; then
  echo "[INFO] 重启 foodflow 服务..."
  if systemctl restart foodflow; then
    sleep 3
  fi
  if systemctl is-active --quiet foodflow; then
    rm -rf "$BACKUP"
    echo "[OK] foodflow 已更新并重启"
  else
    echo "[ERROR] 新版本启动失败，正在回滚..."
    rm -rf node_modules
    [ -d "$BACKUP" ] && mv "$BACKUP" node_modules
    if [ -n "$OLD_SHA" ]; then git reset --hard "$OLD_SHA"; fi
    systemctl restart foodflow || true
    exit 1
  fi
else
  rm -rf "$BACKUP"
  echo "[WARN] 未找到 foodflow.service，源码和依赖已更新但未执行重启"
fi

echo "[OK] 更新完成"
