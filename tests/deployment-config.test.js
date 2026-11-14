'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('all supplied deployment environment templates use the application DB_DATABASE key', () => {
  for (const file of [
    'deploy/standard/.env.example',
    'deploy/enterprise/cluster/.env.example',
    'deploy/enterprise-ultimate/cluster/.env.example'
  ]) {
    const content = read(file);
    assert.match(content, /^DB_DATABASE=/m, file + ' must define DB_DATABASE');
    assert.doesNotMatch(content, /^DB_NAME=/m, file + ' must not use unsupported DB_NAME');
  }
});

test('multi-node deployment templates require shared Redis and an explicit trusted proxy', () => {
  for (const file of [
    'deploy/enterprise/cluster/.env.example',
    'deploy/enterprise-ultimate/cluster/.env.example'
  ]) {
    const content = read(file);
    assert.match(content, /^REDIS_URL=.+/m, file + ' must configure Redis');
    assert.match(content, /^TRUST_PROXY=.+/m, file + ' must configure a trusted proxy');
    assert.match(content, /^REQUIRE_SHARED_REDIS=true$/m, file + ' must enable fail-closed cluster startup');
  }
  for (const file of [
    'deploy/enterprise/cluster/deploy.sh',
    'deploy/enterprise-ultimate/cluster/deploy.sh'
  ]) {
    const content = read(file);
    assert.match(content, /DB_DATABASE/);
    assert.match(content, /REDIS_URL/);
    assert.match(content, /TRUST_PROXY/);
    assert.match(content, /REQUIRE_SHARED_REDIS=true/);
    assert.match(content, /git pull --ff-only origin main/);
    assert.doesNotMatch(content, /git reset --hard origin\/main/);
  }
});

test('load balancer health checks proxy to application readiness, not a static 200', () => {
  const files = [
    'deploy/standard/nginx.conf',
    'deploy/enterprise/cluster/nginx.conf',
    'deploy/enterprise-ultimate/cluster/nginx.conf'
  ];
  const slash = String.fromCharCode(92);
  for (const file of files) {
    const content = read(file);
    assert.ok(content.includes('location ~* ' + slash + '.'), file + ' must have a valid escaped extension regex');
    assert.match(content, /location = \/health[\s\S]*?proxy_pass http[^;]+\/health;/, file);
    assert.doesNotMatch(content, /location = \/health[\s\S]*?return 200/, file);
  }
  const healthRoute = read('routes/health.js');
  assert.match(healthRoute, /app\.get\('\/health', readinessHandler\)/);
  assert.match(healthRoute, /app\.get\('\/api\/health\/ready', readinessHandler\)/);
  assert.match(healthRoute, /app\.get\('\/api\/health', readinessHandler\)/);
  assert.match(healthRoute, /pool\.query\('SELECT 1'\)/);
});

test('enterprise database initialization passes DB_DATABASE into the app process', () => {
  for (const file of [
    'deploy/enterprise/cluster/init-db.sh',
    'deploy/enterprise-ultimate/cluster/init-db.sh'
  ]) {
    assert.match(read(file), /DB_DATABASE=\$DB_NAME[^\n]*node server\.js --init-only/, file);
  }
});

test('health check uses configured database credentials rather than root and a fixed schema', () => {
  const content = read('scripts/health-check.sh');
  assert.match(content, /DB_DATABASE=/);
  assert.match(content, /DB_USER=/);
  assert.match(content, /DB_HOST=/);
  assert.match(content, /MYSQL_PWD=/);
  assert.doesNotMatch(content, /mysql -u root foodflow_system/);
  assert.match(content, /BASE\/health/);
});


test('cluster services keep application code read-only while allowing initial credential state writes', () => {
  for (const variant of ['enterprise', 'enterprise-ultimate']) {
    const deploy = read(`deploy/${variant}/cluster/deploy.sh`);
    const service = read(`deploy/${variant}/cluster/foodflow.service`);
    assert.ok(deploy.includes('chown -R root:www-data /var/www/foodflow'));
    assert.ok(deploy.includes('install -d -o www-data -g www-data -m 0700 /var/lib/foodflow'));
    assert.ok(!deploy.includes('chown -R www-data:www-data /var/www/foodflow'));
    assert.ok(service.includes('/var/lib/foodflow'));
    assert.ok(service.includes('ReadOnlyPaths=/var/www/foodflow'));
  }
});

test('single-host Nginx deployments never write query strings or Referer values to access logs', () => {
  for (const file of [
    'foodflow.conf',
    'deploy/standard/nginx.conf',
    'setup-nginx.sh',
    'install.sh',
    'install-local.sh'
  ]) {
    const content = read(file);
    assert.match(content, /log_format foodflow_safe/, file + ' must define the redacted access log format');
    assert.match(content, /access_log \/var\/log\/nginx\/access\.log foodflow_safe/, file + ' must select the safe access log');
    assert.doesNotMatch(content, /log_format foodflow_safe[^;]*(?:\$request\b|\$request_uri|\$args|\$http_referer)/, file + ' must not log query strings or referrers');
  }
});

test('all Nginx deployment paths allow maximum menu media and backup uploads', () => {
  for (const file of [
    'foodflow.conf',
    'setup-nginx.sh',
    'install.sh',
    'install-local.sh',
    'deploy/standard/nginx.conf',
    'deploy/enterprise/cluster/nginx.conf',
    'deploy/enterprise-ultimate/cluster/nginx.conf'
  ]) {
    const content = read(file);
    assert.match(content, /client_max_body_size 105M;/, file + ' must allow backup imports up to the 50 MB application parser limit');
  }
});
