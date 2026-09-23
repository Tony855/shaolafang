#!/usr/bin/env bash
# FoodFlow 远程更新脚本
# 自动定位到脚本所在目录，拉取最新代码、装依赖、重启服务
# 用法: bash remote-update.sh
set -e

# 切到脚本所在目录（不硬编码路径）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
echo "[INFO] 工作目录: $SCRIPT_DIR"

# 检查 git 仓库
if [ ! -d ".git" ]; then
  echo "[ERROR] 当前目录不是 git 仓库: $SCRIPT_DIR"
  echo "        请先 clone 代码后再运行本脚本"
  exit 1
fi

# 检查必要命令
for cmd in git npm systemctl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[ERROR] 缺少命令: $cmd"
    exit 1
  fi
done

# 拉取最新代码
echo "[INFO] 拉取最新代码..."
git pull

# 安装生产依赖
echo "[INFO] 安装生产依赖..."
npm install --omit=dev

# 重启服务
echo "[INFO] 重启 foodflow 服务..."
if systemctl list-unit-files | grep -q "^foodflow.service"; then
  systemctl daemon-reload
  systemctl restart foodflow
  echo "[OK] foodflow 已重启"
else
  echo "[WARN] 未找到 foodflow.service，请手动启动"
fi

echo "[OK] 更新完成"
