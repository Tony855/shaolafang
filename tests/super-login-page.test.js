'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const registerPageRoutes = require('../routes/pages');

function setup() {
  const handlers = new Map();
  const app = { get(paths, ...callbacks) {
    for (const route of Array.isArray(paths) ? paths : [paths]) handlers.set(route, callbacks[callbacks.length - 1]);
  }};
  registerPageRoutes(app, { getAsync: async () => null, requireAdminKey: (_req,_res,next)=>next(), requirePermission: ()=> (_req,_res,next)=>next() });
  return handlers;
}

function response() {
  return { headers: {}, body: '', setHeader(key,value){this.headers[key]=value;}, send(value){this.body=value;}, redirect(value){this.location=value;} };
}

test('super-admin login is served as a dedicated non-cacheable page', () => {
  const handler = setup().get('/super/login');
  const res = response();
  handler({}, res);
  assert.match(res.body, /id="superLoginForm"/);
  assert.match(res.body, /id="loginUsername"/);
  assert.match(res.body, /id="loginPassword"/);
  assert.equal(res.headers['Cache-Control'], 'no-store, private');
  assert.equal(res.headers.Pragma, 'no-cache');
  assert.doesNotMatch(res.body, /value="superadmin"/);
});

test('super-admin dashboard remains a separate authenticated application page', () => {
  const handlers = setup();
  const res = response();
  handlers.get('/super')({}, res);
  assert.match(res.body, /pages\/super\.js/);
  assert.doesNotMatch(res.body, /id="loginPage"/);
  assert.doesNotMatch(res.body, /id="loginUsername"/);
});
