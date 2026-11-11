'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { removeInitialSuperAdminCredential } = require('../server/services/initial-credentials');
const { isStrongPassword } = require('../server/middleware/password');
const attachSuperRoutes = require('../routes/super');
const registerPageRoutes = require('../routes/pages');
const authSource = require('node:fs').readFileSync(path.join(__dirname, '../server/middleware/auth.js'), 'utf8');
const serverSource = require('node:fs').readFileSync(path.join(__dirname, '../server.js'), 'utf8');

async function fixture(content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foodflow-first-login-'));
  const file = path.join(dir, 'initial-credentials.txt');
  if (content !== null) await fs.writeFile(file, content, { mode: 0o600 });
  return { dir, file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('initial credentials remove only matching super-admin and retain other protected entries', async t => {
  const sample = ['superAdmin: root / secret', 'merchantAdmin: admin / merchant', 'waiter: waiter / waiter-secret', ''].join('\n');
  const f = await fixture(sample);
  t.after(f.cleanup);
  assert.deepEqual(await removeInitialSuperAdminCredential('root', { file: f.file }), { ok: true, removed: true });
  const content = await fs.readFile(f.file, 'utf8');
  assert.equal(content.includes('superAdmin:'), false);
  assert.equal(content.includes('secret'), true);
  assert.match(content, /merchantAdmin: admin/);
  assert.match(content, /waiter: waiter/);
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
});

test('initial credential cleanup refuses username mismatch and tolerates missing file', async t => {
  const f = await fixture('superAdmin: root / secret\n');
  t.after(f.cleanup);
  assert.deepEqual(await removeInitialSuperAdminCredential('other', { file: f.file }), { ok: false, reason: 'username_mismatch' });
  const missing = path.join(f.dir, 'missing');
  assert.deepEqual(await removeInitialSuperAdminCredential('root', { file: missing }), { ok: true, removed: false });
});

test('initial password policy requires length and three character classes', () => {
  assert.equal(isStrongPassword('lowercaseonlypassword'), false);
  assert.equal(isStrongPassword('Lowercase123'), true);
  assert.equal(isStrongPassword('lowercase123!'), true);
  assert.equal(isStrongPassword('UPPERCASE123!'), true);
  assert.equal(isStrongPassword('Aa1!short'), false);
  assert.equal(isStrongPassword('A'.repeat(129) + 'a1!'), false);
});

test('server marks only a newly created super-admin for mandatory rotation', () => {
  assert.ok(serverSource.includes('must_change_password TINYINT NOT NULL DEFAULT 0'));
  assert.ok(serverSource.includes('ALTER TABLE super_admins ADD COLUMN must_change_password TINYINT NOT NULL DEFAULT 0'));
  assert.ok(serverSource.includes('INSERT INTO super_admins (username, password_hash, display_name, must_change_password) VALUES (?, ?, ?, 1)'));
});

test('super-admin middleware gate limits first-login sessions to password rotation and logout', () => {
  assert.ok(authSource.includes('Number(superAdmin.must_change_password) === 1'));
  assert.ok(authSource.includes("req.method === 'POST' && req.path === '/api/super/change-password'"));
  assert.ok(authSource.includes("req.method === 'POST' && req.path === '/api/super/logout'"));
  assert.ok(authSource.includes("code: 'PASSWORD_CHANGE_REQUIRED'"));
});

function appMock() {
  const routes = { get: [], post: [], put: [], delete: [] };
  return {
    routes,
    get(p, ...h) { routes.get.push({ path: p, handlers: h }); },
    post(p, ...h) { routes.post.push({ path: p, handlers: h }); },
    put(p, ...h) { routes.put.push({ path: p, handlers: h }); },
    delete(p, ...h) { routes.delete.push({ path: p, handlers: h }); }
  };
}
function response() {
  return { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; }, json(b) { this.body = b; return this; } };
}
function dependencies(extra = {}) {
  const calls = [];
  return {
    calls, getAsync: async () => null,
    runAsync: async (sql, params = []) => { calls.push({ sql, params }); return { affectedRows: 1 }; },
    allAsync: async () => [], isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt: async () => {}, resetLoginAttempts: async () => {}, cancelLoginAttempt: async () => {},
    verifyPassword: () => true, hashPassword: () => 'new-hash', getClientIp: () => '127.0.0.1',
    getLocationByIp: async () => '', requireSuperAdmin: (_req, _res, next) => next(),
    logAudit: async () => {}, collectBackupData: async () => ({}), autoBackupDatabase: async () => {},
    withTransaction: async callback => callback(),
    removeInitialSuperAdminCredential: async () => ({ ok: true, removed: true }),
    ...extra
  };
}

test('forced rotation revokes all sessions and clears gate after credential cleanup', async () => {
  const app = appMock();
  const deps = dependencies();
  attachSuperRoutes(app, deps);
  const handler = app.routes.post.find(item => item.path === '/api/super/change-password').handlers.at(-1);
  const req = {
    body: { oldPassword: 'Initial-password1!', newPassword: 'New-Strong-Password2!' },
    superAdmin: { id: 7, username: 'root', password_hash: 'old', must_change_password: 1 },
    superSessionToken: 'old-token'
  };
  const res = response();
  await handler(req, res);
  assert.deepEqual(res.body, { success: true, reauthenticate: true });
  assert.ok(deps.calls.some(call => call.sql.includes('DELETE FROM super_sessions WHERE super_admin_id=?') && call.params[0] === 7));
  assert.ok(deps.calls.some(call => call.sql.includes('must_change_password=0')));
  assert.equal(deps.calls.some(call => call.sql.includes('token_hash<>?')), false);
});

test('weak first-login password is rejected without DB writes', async () => {
  const app = appMock();
  const deps = dependencies();
  attachSuperRoutes(app, deps);
  const handler = app.routes.post.find(item => item.path === '/api/super/change-password').handlers.at(-1);
  const res = response();
  await handler({
    body: { oldPassword: 'initial', newPassword: 'weak-password' },
    superAdmin: { id: 7, username: 'root', password_hash: 'old', must_change_password: 1 }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(deps.calls.length, 0);
});

test('failed credential cleanup keeps first-login gate active', async () => {
  const app = appMock();
  const deps = dependencies({ removeInitialSuperAdminCredential: async () => ({ ok: false }) });
  attachSuperRoutes(app, deps);
  const handler = app.routes.post.find(item => item.path === '/api/super/change-password').handlers.at(-1);
  const res = response();
  await handler({
    body: { oldPassword: 'Initial-password1!', newPassword: 'New-Strong-Password2!' },
    superAdmin: { id: 7, username: 'root', password_hash: 'old', must_change_password: 1 }
  }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(deps.calls.some(call => call.sql.includes('must_change_password=0')), false);
});

test('first-login page is non-cacheable and contains new-password fields', () => {
  const routes = new Map();
  const app = { get(paths, ...handlers) { for (const p of Array.isArray(paths) ? paths : [paths]) routes.set(p, handlers.at(-1)); } };
  registerPageRoutes(app, { getAsync: async () => null, requireAdminKey: (_req, _res, next) => next(), requirePermission: () => (_req, _res, next) => next() });
  const handler = routes.get('/super/first-login');
  assert.equal(typeof handler, 'function');
  const res = { headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, send(v) { this.body = v; } };
  handler({}, res);
  assert.match(res.body, /firstLoginForm/);
  assert.match(res.body, /autocomplete="new-password"/);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
});
