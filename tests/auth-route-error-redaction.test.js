'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachAuthRoutes = require('../routes/auth');
const attachMenuZipRoutes = require('../routes/menu-zip');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    setHeader() { return this; },
    send(value) { this.body = value; return this; }
  };
}

test('admin login logs safe metadata only when authentication storage fails', async () => {
  const routes = new Map();
  const app = { post(path, ...handlers) { routes.set(path, handlers); } };
  attachAuthRoutes(app, {
    getAsync: async () => { throw new Error('sensitive database connection details'); },
    runAsync: async () => ({ affectedRows: 1 }),
    isLoginLocked: async () => ({ locked: false }),
    recordLoginAttempt: async () => {},
    resetLoginAttempts: async () => {},
    cancelLoginAttempt: async () => {},
    verifyPassword: () => false,
    getClientIp: () => '127.0.0.1',
    getLocationByIp: async () => '',
    requireAdminKey: (_req, _res, next) => next()
  });

  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args);
  try {
    const res = response();
    await routes.get('/api/admin/login')[0]({
      body: { username: 'admin', password: 'password' },
      get: () => ''
    }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.stringify(logs).includes('sensitive database connection details'), false);
    assert.deepEqual(logs[0][1], { name: 'Error' });
  } finally {
    console.error = original;
  }
});

test('menu ZIP export logs safe metadata only when database access fails', async () => {
  const routes = new Map();
  const pass = (_req, _res, next) => next();
  const app = {
    get(path, ...handlers) { routes.set(path, handlers); },
    post() {}
  };
  attachMenuZipRoutes(app, {
    getAsync: async () => null,
    runAsync: async () => ({ affectedRows: 1 }),
    allAsync: async () => { throw new Error('sensitive database connection details'); },
    requireAdminKey: pass,
    requirePermission: () => pass,
    upload: { single: () => pass },
    UPLOAD_DIR: '/tmp/foodflow-test-uploads'
  });

  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args);
  try {
    const res = response();
    await routes.get('/api/admin/menu/export-zip').at(-1)({ storeId: 9 }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: '请求失败，请稍后重试' });
    assert.equal(JSON.stringify(logs).includes('sensitive database connection details'), false);
    assert.deepEqual(logs[0][1], { name: 'Error' });
  } finally {
    console.error = original;
  }
});
