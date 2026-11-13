#!/usr/bin/env bash
# Shared safety primitives for serialized, fail-closed deployments.
# Safe to source: no commands are executed until a function is called.
FF_DEPLOY_LOCK_FILE="${FF_DEPLOY_LOCK_FILE:-/run/lock/foodflow-deploy.lock}"

ff_acquire_deploy_lock() {
  if [ "${FF_DEPLOY_LOCK_HELD:-0}" = "1" ]; then
    return 0
  fi
  command -v flock >/dev/null 2>&1 || {
    printf '[ERROR] 缺少 flock（util-linux），拒绝并发部署。\n' >&2
    return 1
  }
  mkdir -p "$(dirname "$FF_DEPLOY_LOCK_FILE")"
  exec 9>"$FF_DEPLOY_LOCK_FILE"
  if ! flock -n 9; then
    printf '[ERROR] 另一个 FoodFlow 安装/升级任务正在运行；请等待完成后重试。\n' >&2
    return 1
  fi
  export FF_DEPLOY_LOCK_HELD=1
}

ff_require_clean_git_worktree() {
  local status
  status="$(git status --porcelain --untracked-files=normal)" || return 1
  if [ -n "$status" ]; then
    printf '[ERROR] Git 工作区存在未提交或未跟踪文件，拒绝覆盖。\n%s\n' "$status" >&2
    printf '[INFO] 请先提交、备份或移出这些文件，再执行升级。\n' >&2
    return 1
  fi
}

ff_wait_for_health() {
  local port="${1:-3000}" attempts="${2:-30}" body
  command -v curl >/dev/null 2>&1 || {
    printf '[ERROR] 缺少 curl，无法验证应用健康状态。\n' >&2
    return 1
  }
  for ((i=1; i<=attempts; i++)); do
    if body="$(curl --silent --show-error --fail --max-time 3 "http://127.0.0.1:$port/health" 2>/dev/null)" &&
      node -e 'const x=JSON.parse(process.argv[1]); if(x.status!=="ok" || x.database!=="ok") process.exit(1)' "$body" 2>/dev/null; then
      printf '[OK] 应用与数据库健康检查通过（端口 %s）。\n' "$port"
      return 0
    fi
    sleep 2
  done
  printf '[ERROR] 应用未在预期时间内通过 /health 与数据库就绪检查（端口 %s）。\n' "$port" >&2
  return 1
}

ff_require_port_available() {
  local port="${1:-3000}" listeners
  command -v ss >/dev/null 2>&1 || {
    printf '[ERROR] 缺少 ss（iproute2），无法安全确认端口占用。\n' >&2
    return 1
  }
  listeners="$(ss -H -ltnp "sport = :$port" 2>/dev/null || true)"
  if [ -n "$listeners" ]; then
    printf '[ERROR] TCP 端口 %s 已被占用；安装器不会终止未知进程。\n%s\n' "$port" "$listeners" >&2
    printf '[INFO] 请确认占用进程后手动处理，再重新运行安装。\n' >&2
    return 1
  fi
}
