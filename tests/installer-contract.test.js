'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('shared system bootstrap pins Node.js 26 LTS and verifies runtime', () => {
  const helper = read('scripts/lib/system-deps.sh');
  assert.match(helper, /FF_NODE_MAJOR="\$\{FF_NODE_MAJOR:-26\}"/);
  assert.match(helper, /setup_\$\{wanted_major\}\.x/);
  assert.match(helper, /ff_apt_install nodejs libatomic1/);
  assert.match(helper, /ff_require_node/);
  assert.match(helper, /npm ci --omit=dev --no-audit --no-fund/);
  assert.match(helper, /FF_APT_UPGRADE=1/);
  assert.match(helper, /wanted_major" != "26"/);
});

test('installer OS support is explicit and matches the live CI matrix', () => {
  const helper = read('scripts/lib/system-deps.sh');
  const workflow = read('.github/workflows/installer-compat.yml');
  const smoke = read('scripts/ci/installer-compat.sh');
  for (const os of ['debian:12', 'debian:13', 'ubuntu:22.04', 'ubuntu:24.04']) {
    assert.ok(helper.includes(os), 'helper must explicitly allow ' + os);
  }
  for (const image of ['debian:12-slim', 'debian:13-slim', 'ubuntu:22.04', 'ubuntu:24.04']) {
    assert.ok(workflow.includes(image), 'CI matrix must execute ' + image);
  }
  assert.match(smoke, /ff_require_supported_os/);
  assert.match(smoke, /ff_ensure_node/);
  assert.match(smoke, /ff_npm_ci_production/);
  assert.match(smoke, /nginx -t/);
  assert.match(smoke, /mariadb-install-db/);
  assert.match(smoke, /redis-cli .* ping/);
  assert.match(smoke, /systemd-analyze verify/);
});

test('all first-install and cluster entrypoints use the shared dependency bootstrap', () => {
  const scripts = [
    'install.sh',
    'install-local.sh',
    'deploy/standard/deploy.sh',
    'deploy/enterprise/cluster/deploy.sh',
    'deploy/enterprise-ultimate/cluster/deploy.sh',
    'setup-nginx.sh'
  ];
  for (const file of scripts) {
    const source = read(file);
    assert.match(source, /system-deps\.sh/, file + ' must source shared helper');
  }
  for (const file of [
    'install.sh',
    'install-local.sh',
    'deploy/enterprise/cluster/deploy.sh',
    'deploy/enterprise-ultimate/cluster/deploy.sh'
  ]) {
    assert.match(read(file), /ff_ensure_node/, file + ' must enforce Node LTS');
    assert.match(read(file), /ff_npm_ci_production/, file + ' must install from lockfile');
    assert.doesNotMatch(read(file), /npm install --(?:production|omit=dev)/, file + ' must not use floating npm install');
  }
});

test('installers never purge database packages or delete database data directories', () => {
  for (const file of ['install.sh', 'install-local.sh']) {
    const source = read(file);
    assert.doesNotMatch(source, /apt-get\s+remove\s+--purge[^\n]*(mariadb|mysql)/i, file);
    assert.doesNotMatch(source, /rm\s+-rf\s+\/var\/lib\/mysql/i, file);
    assert.doesNotMatch(source, /rm\s+-rf\s+\/etc\/mysql/i, file);
  }
});

test('whole-system apt upgrade is opt-in and CI uses Node.js 26', () => {
  const helper = read('scripts/lib/system-deps.sh');
  const ci = read('.github/workflows/ci.yml');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.match(helper, /if \[ "\$FF_APT_UPGRADE" = "1" \]/);
  assert.match(ci, /node-version-file: ".nvmrc"/);
  assert.equal(pkg.engines.node, '>=26 <27');
  assert.deepEqual(lock.packages[''].engines, pkg.engines);
  assert.equal(read('.nvmrc').trim(), '26');
});

test('remote updates use the same runtime baseline and locked dependency install', () => {
  const update = read('remote-update.sh');
  assert.match(update, /system-deps\.sh/);
  assert.match(update, /ff_ensure_node/);
  assert.match(update, /npm ci --omit=dev --no-audit --no-fund/);
});



test('deployment safety serializes installers and protects dirty worktrees', () => {
  const safety = read('scripts/lib/deploy-safety.sh');
  const update = read('remote-update.sh');
  const standard = read('deploy/standard/deploy.sh');
  assert.match(safety, /flock -n 9/);
  assert.match(safety, /git status --porcelain --untracked-files=normal/);
  assert.match(safety, /ff_wait_for_health/);
  assert.match(safety, /database!=="ok"/);
  assert.match(update, /ff_acquire_deploy_lock/);
  assert.match(update, /ff_require_clean_git_worktree/);
  assert.match(update, /git reset --hard "\$TARGET_SHA"/);
  assert.match(update, /git reset --hard "\$OLD_SHA"/);
  assert.match(update, /ff_wait_for_health/);
  assert.match(update, /旧版本已重启但健康检查未通过/);
  assert.match(update, /FF_APP_DIR:-/);
  assert.match(update, /trap rollback_update EXIT/);
  assert.ok(update.indexOf('ff_require_clean_git_worktree') < update.indexOf('mktemp -d'));
  assert.match(standard, /ff_acquire_deploy_lock/);
  assert.match(standard, /git pull --ff-only origin main/);
  assert.doesNotMatch(standard, /git pull origin main \|\| log_warn/);
  assert.match(standard, /FF_DEPLOY_LOCK_HELD=1 SKIP_GIT_UPDATE=1/);
  assert.ok(read('install.sh').includes('git -C "$target" show FETCH_HEAD:remote-update.sh'));
  assert.ok(read('install.sh').includes('FF_APP_DIR="$target" FF_DEPLOY_SAFETY_LIB="$safety_tmp"'));
  assert.ok(read('install.sh').includes('FETCH_HEAD:scripts/lib/deploy-safety.sh'));
  assert.ok(read('install.sh').includes('FF_DEPLOY_LOCK_HELD=1 GIT_VERSION="$GIT_VERSION" bash "$updater_tmp"'));
});

test('all deployment entrypoints share a lock and never kill arbitrary port owners', () => {
  const entries = [
    'install.sh', 'install-local.sh', 'deploy/standard/deploy.sh',
    'deploy/enterprise/cluster/deploy.sh',
    'deploy/enterprise-ultimate/cluster/deploy.sh', 'setup-nginx.sh'
  ];
  for (const file of entries) {
    const source = read(file);
    assert.ok(source.includes('deploy-safety.sh'), file + ' must load deployment safety');
    assert.ok(source.includes('ff_acquire_deploy_lock'), file + ' must serialize deployment');
    assert.ok(!source.includes('fuser -k'), file + ' must not kill an unknown port owner');
  }
  assert.ok(read('scripts/lib/deploy-safety.sh').includes('ff_require_port_available'));
  assert.ok(read('install.sh').includes('ff_require_port_available 3000'));
  assert.ok(read('install-local.sh').includes('ff_require_port_available 3000'));
  assert.ok(read('deploy/standard/deploy.sh').includes('ff_require_clean_git_worktree'));
  assert.ok(read('deploy/standard/deploy.sh').includes('git clone "$GIT_REPO" "$DEPLOY_TARGET"'));
  assert.ok(read('deploy/standard/deploy.sh').includes('目标目录非空但不是 Git 仓库'));
  assert.ok(!read('deploy/standard/deploy.sh').includes('rsync -a --delete'));
  assert.ok(read('deploy/standard/deploy.sh').includes('git pull --ff-only origin main'));
  const nginx = read('setup-nginx.sh');
  assert.ok(nginx.includes('check_port_available 80'));
  assert.ok(!nginx.includes('fuser -k'));
  assert.ok(!nginx.includes('kill -9'));
  assert.ok(!nginx.includes('kill_port 80'));
  assert.ok(read('install.sh').includes('DOMAIN="$DOMAIN" EMAIL="$EMAIL" bash setup-nginx.sh'));
});

test('scheduled database backups do not embed passwords in executable scripts', () => {
  const local = read('install-local.sh');
  assert.ok(local.includes('backup.cnf'));
  assert.ok(local.includes('chmod 0600 "$CONFIG_DIR/backup.cnf"'));
  assert.ok(local.includes('--defaults-extra-file=/etc/foodflow/backup.cnf'));
  assert.ok(!local.includes('mysqldump -u foodflow -p'));
  assert.ok(local.includes('crontab -'));
  assert.ok(local.includes('ff_apt_install cron'));
  assert.ok(local.includes('systemctl enable --now cron'));
  assert.ok(local.includes('/usr/local/sbin/foodflow-auto-backup'));
  assert.ok(local.includes('mktemp "$BACKUP_DIR/.db_$DATE.XXXXXX"'));
  assert.ok(local.includes('trap \'rm -f "$TMP_FILE" "$TMP_FILE.gz"\' EXIT'));
  assert.ok(local.includes("cat > \"$BACKUP_SCRIPT\" << 'EOF'"));
});

test('noninteractive installation requires explicit confirmation and cluster role', () => {
  const installer = read('install.sh');
  assert.match(installer, /FF_NONINTERACTIVE:-0/);
  assert.match(installer, /FF_CONFIRM_INSTALL:-0/);
  assert.match(installer, /FF_NODE_ROLE/);
  assert.match(read('setup-nginx.sh'), /FF_NONINTERACTIVE:-0/);
  assert.match(installer, /非交互安装必须显式设置 FF_CONFIRM_INSTALL=1/);
  assert.match(installer, /非交互集群安装必须设置 FF_NODE_ROLE/);
  const domainFn = installer.indexOf('ask_domain_if_needed() {');
  const domainGuard = installer.indexOf('FF_NONINTERACTIVE', domainFn);
  const domainPrompt = installer.indexOf('read -p "  请输入域名', domainFn);
  assert.ok(domainFn >= 0 && domainGuard > domainFn && domainPrompt > domainGuard);
});

test('installer entrypoints enable safe failure diagnostics without logging commands', () => {
  const safety = read('scripts/lib/deploy-safety.sh');
  assert.match(safety, /ff_enable_error_trap/);
  assert.match(safety, /行号 \$line，退出码 \$rc/);
  assert.doesNotMatch(safety, /BASH_COMMAND/);
  for (const file of ['install.sh', 'install-local.sh', 'deploy/standard/deploy.sh', 'deploy/enterprise/cluster/deploy.sh', 'deploy/enterprise-ultimate/cluster/deploy.sh', 'remote-update.sh', 'setup-nginx.sh']) {
    assert.ok(read(file).includes('ff_enable_error_trap'), file + ' must enable diagnostics');
  }
});

test('first install defaults to a minimal single-node path and keeps advanced services opt-in', () => {
  const installer = read('install.sh');
  const local = read('install-local.sh');
  assert.match(installer, /if \[ -z "\$1" \]; then[\s\S]*?DEPLOY_MODE="standard"/);
  assert.match(installer, /FF_INSTALL_REDIS:-0/);
  assert.match(local, /FF_INSTALL_REDIS="\$\{FF_INSTALL_REDIS:-0\}"/);
  assert.match(local, /FF_CONFIGURE_UFW="\$\{FF_CONFIGURE_UFW:-0\}"/);
  assert.match(local, /FF_CONFIGURE_BACKUP_CRON="\$\{FF_CONFIGURE_BACKUP_CRON:-0\}"/);
  assert.match(installer, /REDIS_URL=\$REDIS_URL_VALUE/);
  assert.match(local, /REDIS_URL=\$REDIS_URL_VALUE/);
  assert.match(local, /跳过自动备份计划任务/);
  assert.match(local, /跳过 UFW 自动配置/);
  assert.doesNotMatch(installer, /ff_apt_install nginx build-essential rsync certbot python3-certbot-nginx dnsutils psmisc ufw/);
  assert.doesNotMatch(local, /ff_prepare_system_packages curl wget git nginx build-essential/);
});


test('minimal first-run verification checks configuration, service, database health and credential-file permissions', () => {
  const check = read('scripts/first-run-check.sh');
  const safety = read('scripts/lib/deploy-safety.sh');
  const route = read('routes/health.js');
  const server = read('server.js');
  const installer = read('install.sh');
  const local = read('install-local.sh');
  assert.match(route, /app\.get\('\/health'/);
  assert.match(route, /SELECT 1/);
  assert.match(route, /status\(503\)/);
  assert.match(route, /database: 'unavailable'/);
  assert.match(server, /require\('\.\/routes\/health\.js'\)/);
  assert.match(check, /DB_HOST DB_USER DB_PASSWORD DB_DATABASE/);
  assert.match(check, /systemctl is-active/);
  assert.match(check, /deploy-safety\.sh/);
  assert.match(check, /ff_wait_for_health "\$PORT" "\$\{FF_HEALTH_ATTEMPTS:-30\}"/);
  assert.match(safety, /\/health/);
  assert.match(check, /-perm \/077/);
  assert.doesNotMatch(check, /cat "\$CREDENTIALS_FILE"/);
  assert.match(installer, /scripts\/first-run-check\.sh/);
  assert.match(local, /scripts\/first-run-check\.sh/);
  assert.match(installer, /RUN_SCHEDULED_TASKS=false/);
  assert.match(local, /RUN_SCHEDULED_TASKS=false/);
  assert.doesNotMatch(installer, /RUN_SCHEDULED_TASKS=true/);
  assert.doesNotMatch(local, /RUN_SCHEDULED_TASKS=true/);
});


test('cluster NFS exports preserve existing exports and restrict uploads to the application service identity', () => {
  for (const file of [
    'deploy/enterprise/cluster/setup-nfs-server.sh',
    'deploy/enterprise-ultimate/cluster/setup-nfs-server.sh'
  ]) {
    const source = read(file);
    assert.match(source, /root_squash/);
    assert.ok(source.includes('readonly NFS_UPLOAD_UID=33'));
    assert.ok(source.includes('readonly NFS_UPLOAD_GID=33'));
    assert.match(source, /-m 0770/);
    assert.match(source, /NFS_CLIENT_CIDR/);
    assert.match(source, /awk -v export_path/);
    assert.ok(source.includes('exportfs -ra'));
    assert.ok(!source.includes('systemctl restart nfs-kernel-server'));
    assert.doesNotMatch(source, /no_root_squash|chmod 777|chown nobody:nogroup/);
    assert.doesNotMatch(source, /cat > \/etc\/exports/);
  }
});


test('cluster app deployment requires a writable shared NFS mount and stable www-data identity', () => {
  for (const file of [
    'deploy/enterprise/cluster/deploy.sh',
    'deploy/enterprise-ultimate/cluster/deploy.sh'
  ]) {
    const source = read(file);
    assert.ok(source.includes('groupadd --system --gid 33 www-data'));
    assert.ok(source.includes('useradd --system --no-create-home --uid 33 --gid 33'));
    assert.ok(source.includes('mountpoint -q /mnt/shared/uploads'));
    assert.ok(source.includes('findmnt -n -o FSTYPE'));
    assert.ok(source.includes('nfs|nfs4'));
    assert.ok(source.includes('runuser -u www-data -- test -w /mnt/shared/uploads'));
    assert.ok(source.includes('/api/health/ready'));
    assert.ok(source.includes('READY_STATUS'));
    assert.ok(source.includes('curl --silent --show-error --output /dev/null'));
    assert.ok(source.includes('DB_PASSWORD'));
    assert.ok(source.includes('YourStrongPasswordHere'));
    assert.ok(source.includes('ChangeThisToARandomString'));
    assert.ok(source.includes('DB_USER'));
    assert.ok(source.includes('REDIS_URL'));
    assert.ok(source.includes('client.ping()'));
    assert.ok(source.includes('connectTimeout: 5000'));
    assert.ok(source.includes('REDIS_URL="$REDIS_URL" node'));
    assert.ok(source.includes('QR_DOMAIN'));
    assert.ok(source.includes('JWT_SECRET'));
    assert.ok(!source.includes('useradd -r -s /bin/false www-data'));
  }
});


test('enterprise deployment guides reference their own cluster scripts', () => {
  const enterprise = read('deploy/enterprise/README.md');
  const ultimate = read('deploy/enterprise-ultimate/README.md');
  assert.doesNotMatch(enterprise, /deploy\/standard\/cluster\//);
  assert.match(enterprise, /deploy\/enterprise\/cluster\/deploy\.sh/);
  assert.ok(enterprise.includes('NFS_CLIENT_CIDR='));
  assert.doesNotMatch(ultimate, /deploy\/enterprise\/cluster\//);
  assert.match(ultimate, /deploy\/enterprise-ultimate\/cluster\/deploy\.sh/);
  assert.ok(ultimate.includes('NFS_CLIENT_CIDR='));
});


test('manual installation guides use the canonical repository and a non-root service account', () => {
  const install = read('INSTALL.md');
  const readme = read('README.md');
  assert.ok(install.includes('https://github.com/Tony855/shaolafang.git'));
  assert.ok(install.includes('DB_USER=foodflow'));
  assert.ok(install.includes('DB_DATABASE=foodflow_system'));
  assert.ok(install.includes('User=foodflow\nGroup=www-data'));
  assert.ok(!install.includes('DB_USER=root'));
  assert.ok(!install.includes('User=root'));
  assert.ok(!install.includes('ufw allow 3000/tcp'));
  assert.ok(readme.includes('User=foodflow\nGroup=www-data'));
  assert.ok(!readme.includes('User=foodflow\nGroup=foodflow'));
});


test('top-level deployment guides and standard installer use the current repository contracts', () => {
  const standard = read('DEPLOY-STANDARD.md');
  const enterprise = read('DEPLOY-ENTERPRISE.md');
  const standardGuide = read('deploy/standard/README.md');
  const deployGuide = read('deploy/README.md');
  const standardScript = read('deploy/standard/deploy.sh');
  assert.ok(standard.includes('Tony855/shaolafang.git'));
  assert.ok(standard.includes('deploy/standard/README.md'));
  assert.doesNotMatch(standard, /foodflow-standard\.git|DB_USER=root/);
  assert.ok(enterprise.includes('deploy/enterprise/README.md'));
  assert.ok(enterprise.includes('deploy/enterprise-ultimate/README.md'));
  assert.doesNotMatch(enterprise, /foodflow-enterprise\.git|DB_USER=root|k8s\/redis-cluster\.yaml/);
  assert.ok(standardGuide.includes('Tony855/shaolafang.git'));
  assert.ok(standardGuide.includes('执行定时任务 | false'));
  assert.ok(deployGuide.includes('Tony855/shaolafang.git'));
  assert.ok(standardScript.includes('GIT_REPO="https://github.com/Tony855/shaolafang.git"'));
});


test('first-install and cluster startup use readiness gates instead of fixed startup sleeps', () => {
  for (const file of ['install.sh', 'install-local.sh']) {
    const source = read(file);
    assert.match(source, /ff_wait_for_health "\$BACKEND_PORT" "\$\{FF_HEALTH_ATTEMPTS:-30\}"/, file + ' must wait for app and database readiness');
    assert.match(source, /sed -n 's\/\^PORT=\//, file + ' must read the configured application port');
    assert.match(source, /BACKEND_PORT.*-gt 65535/, file + ' must validate the configured port');
    assert.match(source, /if ! systemctl restart/, file + ' must diagnose restart failures');
    assert.doesNotMatch(source, /systemctl restart [^\n]+\n\s*sleep 8/, file + ' must not rely on a fixed startup delay');
  }
  for (const file of ['deploy/enterprise/cluster/deploy.sh', 'deploy/enterprise-ultimate/cluster/deploy.sh']) {
    const source = read(file);
    assert.match(source, /if ! systemctl restart foodflow/, file + ' must diagnose restart failures');
    assert.match(source, /\/api\/health\/ready/, file + ' must wait for database readiness');
    assert.doesNotMatch(source, /systemctl restart foodflow\n\s*sleep 5/, file + ' must not rely on a fixed startup delay');
  }
});

test('Nginx setup gates proxy configuration on application and database readiness', () => {
  const nginx = read('setup-nginx.sh');
  assert.match(nginx, /systemctl restart foodflow/);
  assert.match(nginx, /ff_wait_for_health "\$BACKEND_PORT" "\$\{FF_HEALTH_ATTEMPTS:-30\}"/);
  assert.ok(nginx.indexOf('ff_wait_for_health') < nginx.indexOf('# ===== 4. 释放 80 端口 ====='));
  assert.match(nginx, /journalctl -u foodflow -n 50 --no-pager/);
  assert.doesNotMatch(nginx, /sleep 3\s+if systemctl is-active/);
});


test('systemd services throttle repeated startup crashes instead of restarting forever', () => {
  const units = [
    ['install.sh', read('install.sh')],
    ['install-local.sh', read('install-local.sh')],
    ['deploy/standard/foodflow.service', read('deploy/standard/foodflow.service')],
    ['deploy/enterprise/cluster/foodflow.service', read('deploy/enterprise/cluster/foodflow.service')],
    ['deploy/enterprise-ultimate/cluster/foodflow.service', read('deploy/enterprise-ultimate/cluster/foodflow.service')],
    ['INSTALL.md', read('INSTALL.md')]
  ];
  for (const [file, source] of units) {
    assert.match(source, /StartLimitIntervalSec=60s/, file + ' must define a bounded restart window');
    assert.match(source, /StartLimitBurst=5/, file + ' must cap repeated start attempts');
    assert.match(source, /Restart=on-failure/, file + ' must restart only failed processes');
    assert.doesNotMatch(source, /Restart=always/, file + ' must not restart successful exits forever');
  }
});
