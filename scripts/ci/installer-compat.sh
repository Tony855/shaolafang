#!/usr/bin/env bash
# Real package/runtime smoke test executed inside disposable Debian/Ubuntu containers.
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "[ERROR] compatibility matrix must run as root" >&2
  exit 1
fi

# Prevent package post-install hooks from trying to start services without systemd.
cat >/usr/sbin/policy-rc.d <<'POLICY'
#!/bin/sh
exit 101
POLICY
chmod 0755 /usr/sbin/policy-rc.d

source scripts/lib/system-deps.sh
ff_require_supported_os

apt-get update -qq
ff_apt_install ca-certificates curl gnupg nginx mariadb-server redis-server systemd systemd-sysv
ff_ensure_node
ff_npm_ci_production

node -e 'if (Number(process.versions.node.split(".")[0]) !== 26) process.exit(1)'
npm --version
nginx -t
mariadbd --version
redis-server --version
systemd-analyze --version

# Validate the shipped systemd unit without requiring a running systemd PID 1.
getent group www-data >/dev/null
if ! id foodflow >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin foodflow
fi
mkdir -p /var/www/foodflow /etc/foodflow
: >/var/www/foodflow/.env
systemd-analyze verify deploy/standard/foodflow.service

tmp_dir="$(mktemp -d)"
redis_pid=""
mariadb_pid=""
cleanup() {
  if [ -n "$redis_pid" ]; then redis-cli -s "$tmp_dir/redis.sock" shutdown nosave >/dev/null 2>&1 || true; fi
  if [ -n "$mariadb_pid" ]; then
    mariadb-admin --no-defaults --socket="$tmp_dir/mariadb/mariadb.sock" -uroot shutdown >/dev/null 2>&1 || kill "$mariadb_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

# Start Redis directly because these CI containers intentionally do not run systemd.
redis-server --port 0 --unixsocket "$tmp_dir/redis.sock" --unixsocketperm 700 --daemonize yes --pidfile "$tmp_dir/redis.pid" --dir "$tmp_dir"
redis_pid="$(cat "$tmp_dir/redis.pid")"
redis-cli -s "$tmp_dir/redis.sock" ping | grep -qx PONG

# Initialize and start an isolated MariaDB instance; no host or production data is touched.
mkdir -p "$tmp_dir/mariadb"
chown mysql:mysql "$tmp_dir/mariadb"
mariadb-install-db --datadir="$tmp_dir/mariadb" --auth-root-authentication-method=normal --skip-test-db --user=mysql >/tmp/mariadb-install-db.log 2>&1
mariadbd --no-defaults --user=mysql --datadir="$tmp_dir/mariadb" --socket="$tmp_dir/mariadb/mariadb.sock" --pid-file="$tmp_dir/mariadb/mariadb.pid" --skip-networking --log-error="$tmp_dir/mariadb/mariadb.log" &
mariadb_pid=$!
ready=0
for _ in $(seq 1 45); do
  if mariadb-admin --no-defaults --socket="$tmp_dir/mariadb/mariadb.sock" -uroot ping >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  cat "$tmp_dir/mariadb/mariadb.log" >&2 || true
  echo "[ERROR] isolated MariaDB did not become ready" >&2
  exit 1
fi
mariadb --no-defaults --socket="$tmp_dir/mariadb/mariadb.sock" -uroot -e 'SELECT VERSION()'

echo "[PASS] installer compatibility smoke test: $(. /etc/os-release; printf "%s %s" "$PRETTY_NAME" "$VERSION_ID")"
