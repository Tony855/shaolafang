'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('standalone install.sh downloads the full archive and re-executes the installer with arguments', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-installer-bootstrap-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const standaloneDir = path.join(temp, 'standalone');
  const fixtureRoot = path.join(temp, 'archive-root');
  const binDir = path.join(temp, 'bin');
  fs.mkdirSync(standaloneDir, { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(path.join(root, 'install.sh'), path.join(standaloneDir, 'install.sh'));
  const marker = path.join(temp, 'bootstrap-ran.txt');
  const fixtureInstaller = [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    '[ "$FF_INSTALLER_BOOTSTRAPPED" = "1" ]',
    '[ "$GIT_VERSION" = "main" ]',
    'printf "%s\\n" "$@" > "$BOOTSTRAP_TEST_MARKER"',
    'printf "bootstrapped\\n" >> "$BOOTSTRAP_TEST_MARKER"',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(fixtureRoot, 'install.sh'), fixtureInstaller);
  fs.writeFileSync(path.join(fixtureRoot, 'scripts', 'lib', 'system-deps.sh'), '# fixture dependency\n');
  fs.writeFileSync(path.join(fixtureRoot, 'scripts', 'lib', 'deploy-safety.sh'), '# fixture dependency\n');
  const archive = path.join(temp, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', temp, 'archive-root']);
  const fakeCurl = path.join(binDir, 'curl');
  const fakeCurlScript = [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    "output=''",
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--output" ]; then',
    '    shift',
    '    output="$1"',
    '  fi',
    '  shift',
    'done',
    '[ -n "$output" ]',
    'cp "$BOOTSTRAP_TEST_ARCHIVE" "$output"',
    ''
  ].join('\n');
  fs.writeFileSync(fakeCurl, fakeCurlScript);
  fs.chmodSync(fakeCurl, 0o755);
  const result = spawnSync('bash', [
    path.join(standaloneDir, 'install.sh'),
    '--deployment-mode', 'standard'
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: binDir + ':' + process.env.PATH,
      BOOTSTRAP_TEST_ARCHIVE: archive,
      BOOTSTRAP_TEST_MARKER: marker,
      GIT_VERSION: 'main'
    }
  });
  assert.equal(result.status, 0, 'stdout:\n' + result.stdout + '\nstderr:\n' + result.stderr);
  assert.match(result.stdout, /已获取完整 Shaolafang 安装包/);
  assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), [
    '--deployment-mode', 'standard', 'bootstrapped'
  ]);
});

test('standalone install.sh rejects an unsafe GIT_VERSION before downloading', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-installer-invalid-version-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(temp, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'install.sh'), path.join(temp, 'install.sh'));
  const result = spawnSync('bash', [path.join(temp, 'install.sh')], {
    encoding: 'utf8',
    env: { ...process.env, GIT_VERSION: '../main' }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /无效的 GIT_VERSION/);
});
