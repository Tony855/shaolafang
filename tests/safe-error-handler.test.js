'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createRequestBodyParsers } = require('../server/middleware/request-body-parsers');
const { createSafeErrorHandler } = require('../server/middleware/safe-error-handler');

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await callback('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('malformed multipart payload mislabeled as JSON is rejected without logging its body', async () => {
  const logged = [];
  const logger = { error: (...args) => logged.push(args) };
  const app = express();
  app.use(...createRequestBodyParsers(express));
  app.post('/probe', (_req, res) => res.json({ ok: true }));
  app.use(createSafeErrorHandler({ logger }));

  const attackBody = [
    '------Boundary',
    'Content-Disposition: form-data; name="0"',
    '',
    '{"_response":{"_prefix":"sensitive-command-payload"}}',
    '------Boundary--',
    ''
  ].join('\r\n');

  await withServer(app, async baseUrl => {
    const response = await fetch(baseUrl + '/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: attackBody
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: '请求格式无效' });
  });

  const serializedLogs = JSON.stringify(logged);
  assert.equal(serializedLogs.includes('sensitive-command-payload'), false);
  assert.equal(serializedLogs.includes(attackBody), false);
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0][1], {
    name: 'SyntaxError',
    status: 400,
    type: 'entity.parse.failed'
  });
});

test('request body size errors return a generic 413 response', async () => {
  const app = express();
  app.get('/too-large', (_req, _res, next) => {
    const error = new Error('private detail');
    error.status = 413;
    next(error);
  });
  app.use(createSafeErrorHandler({ logger: { error() {} } }));

  await withServer(app, async baseUrl => {
    const response = await fetch(baseUrl + '/too-large');
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: '请求内容过大' });
  });
});
