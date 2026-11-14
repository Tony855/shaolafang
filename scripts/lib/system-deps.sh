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

# Install a maintained MariaDB LTS on clean installs only. Existing databases are
# detected by install.sh before this helper is called and are never upgraded here.
ff_install_mariadb_server() {
  local requested_version="${FF_MARIADB_SERVER_VERSION:-12.3}"
  local setup_file candidate actual_version checksum
  case "$requested_version" in
    10.11|11.4|11.8|12.3) ;;
    *)
      ff_log_error "不支持的 FF_MARIADB_SERVER_VERSION=$requested_version；可选 10.11/11.4/11.8/12.3。"
      return 1
      ;;
  esac

  # MariaDB's documented APT repository platforms: Debian 12/13 and
  # Ubuntu 22.04/24.04. Install the GPG/HTTPS prerequisites before configuring it.
  ff_apt_install ca-certificates curl gnupg dirmngr apt-transport-https || return 1
  case "${ID:-}:${VERSION_ID:-}" in
    debian:12|debian:13|ubuntu:22.04|ubuntu:24.04)
      # mariadb_repo_setup release 2026-09-15; checksum published by MariaDB.
      checksum="b54c87edfe81b9837ef44a4a4f39383dd8df32776e6a18c0743a5d3ece044ac3"
      setup_file="$(mktemp)"
      if ! curl -fsSL https://r.mariadb.com/downloads/mariadb_repo_setup -o "$setup_file"; then
        rm -f "$setup_file"
        ff_log_error "下载 MariaDB 官方仓库配置脚本失败。"
        return 1
      fi
      if ! printf '%s  %s\n' "$checksum" "$setup_file" | sha256sum -c - >/dev/null 2>&1; then
        rm -f "$setup_file"
        ff_log_error "MariaDB 官方仓库配置脚本校验失败，拒绝执行。"
        return 1
      fi
      if ! bash "$setup_file" --mariadb-server-version="mariadb-$requested_version" --skip-maxscale --skip-tools; then
        rm -f "$setup_file"
        ff_log_error "配置 MariaDB $requested_version 官方仓库失败。"
        return 1
      fi
      rm -f "$setup_file"
      ff_apt_update || return 1
      candidate="$(apt-cache policy mariadb-server 2>/dev/null | awk '$1 == "Candidate:" { print $2; exit }')"
      case "$candidate" in
        *"$requested_version".*) ;;
        *)
          ff_log_error "MariaDB 仓库候选版本不符合要求：期望 $requested_version，实际 ${candidate:-无候选版本}。"
          return 1
          ;;
      esac
      ff_log_info "安装 MariaDB Community Server $requested_version LTS..."
      ff_apt_install mariadb-server || return 1
      ;;
    ubuntu:26.04)
      # MariaDB's documented Community APT setup does not yet list Ubuntu 26.04.
      # Ubuntu 26.04's native archive currently supplies the maintained 11.8 LTS.
      if [ "${FF_MARIADB_SERVER_VERSION:-}" != "" ] && [ "$requested_version" != "11.8" ]; then
        ff_log_error "Ubuntu 26.04 当前使用发行版仓库的 MariaDB 11.8 LTS；官方 MariaDB APT 仓库尚未列出该系统，不支持强制指定 $requested_version。"
        return 1
      fi
      ff_apt_update || return 1
      candidate="$(apt-cache policy mariadb-server 2>/dev/null | awk '$1 == "Candidate:" { print $2; exit }')"
      case "$candidate" in
        *11.8.*) ;;
        *)
          ff_log_error "Ubuntu 26.04 需要发行版仓库提供 MariaDB 11.8 LTS，实际候选版本为 ${candidate:-无候选版本}。"
          return 1
          ;;
      esac
      ff_log_info "Ubuntu 26.04 使用发行版仓库提供的 MariaDB 11.8 LTS。"
      ff_apt_install mariadb-server || return 1
      ;;
    *)
      ff_log_error "当前系统未配置经过验证的 MariaDB LTS 安装来源。"
      return 1
      ;;
  esac

  actual_version="$(mariadbd --version 2>/dev/null || mysqld --version 2>/dev/null || true)"
  case "$actual_version" in
    *"$requested_version".*) ;;
    *"11.8."*)
      if [ "${ID:-}:${VERSION_ID:-}" = "ubuntu:26.04" ] && [ "$requested_version" = "12.3" ]; then
        ff_log_info "检测到 Ubuntu 26.04 的 MariaDB 11.8 LTS 发行版包，符合该系统的受支持安装基线。"
        return 0
      fi
      ff_log_error "安装后的 MariaDB 版本不符合要求：$actual_version"
      return 1
      ;;
    *)
      ff_log_error "无法确认安装后的 MariaDB LTS 版本：${actual_version:-mariadbd/mysqld 不可用}"
      return 1
      ;;
  esac
  ff_log_info "MariaDB 版本验证通过：$actual_version"
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
