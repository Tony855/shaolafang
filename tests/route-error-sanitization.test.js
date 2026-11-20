'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routesDir = path.join(__dirname, '..', 'routes');
const routeFiles = fs.readdirSync(routesDir).filter(file => file.endsWith('.js'));
const unsafePatterns = [
  /(?:e|err|error)\.(?:status|statusCode)\s*\?\s*(?:e|err|error)\.message/,
  /res\.status\(\s*(?:e|err|error)\.(?:status|statusCode)\s*\|\|\s*500\s*\)\.json\(\s*\{\s*error:\s*(?:e|err|error)\.message/
];

test('menu batch import must not return raw database or provider error messages', () => {
  const menuSource = fs.readFileSync(path.join(routesDir, 'menu.js'), 'utf8');
  assert.ok(menuSource.includes('errors.push(`第 ${i+1} 行：导入失败，请检查菜品数据或联系管理员`);'));
  assert.equal(menuSource.includes("errors.push(`第 ${i+1} 行：${e.message}`);"), false);
});

test('Telegram bot test route must mask unexpected provider and network errors', () => {
  const superSource = fs.readFileSync(path.join(routesDir, 'super.js'), 'utf8');
  assert.ok(superSource.includes("normalizeRouteError(error, 'Telegram 测试消息发送失败，请检查 Bot 配置与网络连接')"));
  assert.equal(superSource.includes("res.status(400).json({ error: error.message || 'Telegram 测试消息发送失败' });"), false);
});

test('route handlers must not expose arbitrary error messages for 5xx responses', () => {
  for (const file of routeFiles) {
    const source = fs.readFileSync(path.join(routesDir, file), 'utf8');
    for (const pattern of unsafePatterns) {
      assert.doesNotMatch(source, pattern, file + ' contains an unsafe error response pattern');
    }
  }
});
