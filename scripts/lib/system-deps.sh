#!/usr/bin/env bash
# Shared Debian/Ubuntu system dependency bootstrap for all FoodFlow installers.
# Keep this file safe to source: it performs no work until a function is called.

FF_NODE_MAJOR="${FF_NODE_MAJOR:-26}"
FF_APT_UPGRADE="${FF_APT_UPGRADE:-0}"

ff_log_info() { printf '[INFO] %s\n' "$*"; }
ff_log_warn() { printf '[WARN] %s\n' "$*" >&2; }
ff_log_error() { printf '[ERROR] %s\n' "$*" >&2; }

ff_require_supported_os() {
  if [ ! -r /etc/os-release ]; then
    ff_log_error "无法读取 /etc/os-release；仅支持 Debian 12/13 和 Ubuntu 22.04/24.04/26.04。"
    return 1
  fi
  # shellcheck source=/etc/os-release
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    debian:12|debian:13|ubuntu:22.04|ubuntu:24.04|ubuntu:26.04) ;;
    *)
      ff_log_error "当前系统 ${PRETTY_NAME:-${ID:-unknown}} 未通过安装兼容性验证；支持 Debian 12/13、Ubuntu 22.04/24.04/26.04。"
      return 1
      ;;
  esac
}

ff_apt_update() {
  ff_require_supported_os || return 1
  apt-get update -qq
}

ff_apt_install() {
  if [ "$#" -eq 0 ]; then return 0; fi
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}

ff_prepare_system_packages() {
  ff_apt_update || return 1
  ff_apt_install ca-certificates curl wget git gnupg iproute2 util-linux
  if [ "$FF_APT_UPGRADE" = "1" ]; then
    ff_log_warn "FF_APT_UPGRADE=1：正在执行整机软件包升级；部分系统更新可能需要维护窗口或重启。"
    DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
  else
    ff_log_info "跳过整机 apt upgrade（可在维护窗口显式设置 FF_APT_UPGRADE=1）。"
  fi
  if [ "$#" -gt 0 ]; then ff_apt_install "$@"; fi
}

ff_ensure_node() {
  local wanted_major="$FF_NODE_MAJOR"
  local current_version=""
  if [ "$wanted_major" != "26" ]; then
    ff_log_error "当前安装基线固定为 Node.js 26 LTS；FF_NODE_MAJOR 不允许覆盖为其他主版本。"
    return 1
  fi
  if command -v node >/dev/null 2>&1; then
    current_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  fi
  ff_apt_update || return 1
  ff_apt_install ca-certificates curl gnupg libatomic1
  local setup_file
  setup_file="$(mktemp)"
  ff_log_info "配置 NodeSource Node.js ${wanted_major}.x 仓库（当前：${current_version:-未安装}）..."
  if ! curl -fsSL "https://deb.nodesource.com/setup_${wanted_major}.x" -o "$setup_file"; then
    rm -f "$setup_file"
    ff_log_error "下载 NodeSource 安装脚本失败。"
    return 1
  fi
  if ! bash "$setup_file"; then
    rm -f "$setup_file"
    ff_log_error "配置 NodeSource 仓库失败。"
    return 1
  fi
  rm -f "$setup_file"
  ff_apt_install nodejs libatomic1
  hash -r
  ff_require_node
}

ff_require_node() {
  if [ "$FF_NODE_MAJOR" != "26" ]; then
    ff_log_error "当前运行时基线固定为 Node.js 26 LTS。"
    return 1
  fi
  local actual_version=""
  local actual_major=""
  actual_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  actual_major="${actual_version%%.*}"
  if [ "$actual_major" != "$FF_NODE_MAJOR" ]; then
    ff_log_error "Node.js 版本不匹配：要求 ${FF_NODE_MAJOR}.x，实际 ${actual_version:-未安装}。"
    return 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    ff_log_error "Node.js 已安装，但 npm 命令不可用。"
    return 1
  fi
  ff_log_info "Node.js $(node -v)，npm $(npm --version)"
}

ff_npm_ci_production() {
  if [ ! -f package.json ] || [ ! -f package-lock.json ]; then
    ff_log_error "缺少 package.json 或 package-lock.json；拒绝使用不确定版本安装依赖。"
    return 1
  fi
  ff_require_node || return 1
  npm ci --omit=dev --no-audit --no-fund
}
