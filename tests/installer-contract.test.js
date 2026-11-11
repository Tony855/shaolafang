'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('shared system bootstrap pins the supported Node LTS and verifies runtime', () => {
  const helper = read('scripts/lib/system-deps.sh');
  assert.match(helper, /FF_NODE_MAJOR="\$\{FF_NODE_MAJOR:-26\}"/);
  assert.match(helper, /setup_\$\{wanted_major\}\.x/);
  assert.match(helper, /ff_apt_install nodejs libatomic1/);
  assert.match(helper, /ff_require_node/);
  assert.match(helper, /npm ci --omit=dev --no-audit --no-fund/);
  assert.match(helper, /FF_APT_UPGRADE=1/);
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
  assert.match(ci, /node-version: "26"/);
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
