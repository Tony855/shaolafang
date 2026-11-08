'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerPageRoutes = require('../routes/pages');

test('QR print escapes database and host values in HTML and inline-script contexts', async () => {
  let qrHandler;
  const app = {
    get(route, ...handlers) {
      if (route === '/qr-print') qrHandler = handlers[handlers.length - 1];
    }
  };
  const tableName = '</title><script>alert(1)</script>$&';
  const storeName = '</div><img src=x onerror=alert(2)>';
  const ctx = {
    getAsync: async sql => {
      if (sql.includes('FROM tables')) return { name: tableName, qr_token: 'safe-token', store_id: 3 };
      if (sql.includes('FROM stores')) return { name: storeName, qr_languages: 'en' };
      throw new Error('Unexpected SQL in QR print test');
    },
    requireAdminKey: () => (_req, _res, next) => next(),
    requirePermission: () => (_req, _res, next) => next()
  };
  registerPageRoutes(app, ctx);
  assert.equal(typeof qrHandler, 'function');

  let html = '';
  const headers = {};
  const req = {
    query: { tableId: '9', lang: 'en' },
    protocol: 'https',
    storeId: 3,
    merchantId: 7,
    get: name => name === 'host' ? 'example.test" onfocus="alert(3)' : undefined
  };
  const res = {
    setHeader: (name, value) => { headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    send(value) { html = value; return this; }
  };

  await qrHandler(req, res);

  assert.equal(res.statusCode, undefined);
  assert.equal(headers['Cache-Control'], 'no-store, private');
  assert.ok(html.includes('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;$&amp;'));
  assert.ok(html.includes('&lt;/div&gt;&lt;img src=x onerror=alert(2)&gt;'));
  assert.ok(html.includes('example.test&quot; onfocus=&quot;alert(3)'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x onerror=alert(2)>'));
  assert.ok(html.includes('\\u003c/title\\u003e\\u003cscript\\u003e'));
  assert.ok(html.includes('\\u003c/div\\u003e\\u003cimg'));
});
