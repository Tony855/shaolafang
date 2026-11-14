'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const multer = require('multer');
const { createRequestBodyParsers } = require('../server/middleware/request-body-parsers');
const { safeErrorMetadata } = require('../server/middleware/safe-error-metadata');

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await callback('http://127.0.0.1:' + address.port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('URL-encoded and multipart requests reach their intended parsers', async () => {
  const app = express();
  app.use(...createRequestBodyParsers(express));
  const upload = multer({ storage: multer.memoryStorage() });

  app.post('/form', (req, res) => res.json({ value: req.body.value }));
  app.post('/upload', upload.single('image'), (req, res) => {
    res.json({ value: req.body.value, filename: req.file?.originalname || null });
  });

  await withServer(app, async baseUrl => {
    const form = await fetch(baseUrl + '/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ value: 'form-ok' })
    });
    assert.equal(form.status, 200);
    assert.deepEqual(await form.json(), { value: 'form-ok' });

    const multipartBody = new FormData();
    multipartBody.set('value', 'multipart-ok');
    multipartBody.set('image', new Blob(['image-bytes'], { type: 'image/png' }), 'test.png');
    const multipart = await fetch(baseUrl + '/upload', {
      method: 'POST',
      body: multipartBody
    });
    assert.equal(multipart.status, 200);
    assert.deepEqual(await multipart.json(), { value: 'multipart-ok', filename: 'test.png' });
  });
});

test('backup import bypasses the default JSON limit for its route-specific parser', async () => {
  const app = express();
  app.use(...createRequestBodyParsers(express));
  app.post('/api/super/backup/import', express.json({ limit: '3mb' }), (req, res) => {
    res.json({ length: req.body.value.length });
  });

  await withServer(app, async baseUrl => {
    const value = 'x'.repeat(2 * 1024 * 1024 + 32);
    const response = await fetch(baseUrl + '/api/super/backup/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { length: value.length });
  });
});

test('safe error metadata excludes request bodies, messages, and stack traces', () => {
  const metadata = safeErrorMetadata({
    name: 'SyntaxError',
    status: 400,
    type: 'entity.parse.failed',
    body: '{"password":"secret"}',
    message: 'secret request payload',
    stack: 'secret stack'
  });
  assert.deepEqual(metadata, {
    name: 'SyntaxError',
    status: 400,
    type: 'entity.parse.failed'
  });
  assert.equal(JSON.stringify(metadata).includes('secret'), false);
});
