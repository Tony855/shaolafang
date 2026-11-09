'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerPageRoutes = require('../routes/pages');

function middleware() {
  return (_req, _res, next) => next();
}

function setup() {
  let qrPrintHandler;
  const calls = [];
  const app = {
    get(path, ...callbacks) {
      if (path === '/qr-print') qrPrintHandler = callbacks[callbacks.length - 1];
    }
  };
  registerPageRoutes(app, {
    getAsync: async (sql, params) => {
      calls.push({ sql, params });
      return null;
    },
    requireAdminKey: middleware(),
    requirePermission: () => middleware()
  });
  return { qrPrintHandler, calls };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    send(value) { this.body = value; return this; },
    setHeader() {}
  };
}

test('QR print rejects non-canonical table IDs before querying the database', async () => {
  for (const tableId of ['1e0', '12junk', '0', ' 12 ', '9007199254740992']) {
    const { qrPrintHandler, calls } = setup();
    const res = response();
    await qrPrintHandler({ query: { tableId }, storeId: 9 }, res);

    assert.equal(res.statusCode, 400, 'tableId=' + tableId);
    assert.equal(res.body, 'Invalid tableId');
    assert.equal(calls.length, 0, 'invalid table ID must not reach SQL');
  }
});
