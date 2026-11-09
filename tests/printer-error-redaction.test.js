'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePrinterError } = require('../server/services/printer');

test('printer errors never expose internal IPs, ports, or socket diagnostics', () => {
  const internalError = new Error('connect ECONNREFUSED 10.20.30.40:9100');
  const publicMessage = sanitizePrinterError(internalError);
  assert.equal(publicMessage, '打印机连接失败，请检查设备连接和网络设置');
  assert.doesNotMatch(publicMessage, /10\.20\.30\.40|9100|ECONNREFUSED/);
});

test('printer error redaction is stable for timeout and DNS failures', () => {
  for (const message of ['打印机连接超时', 'getaddrinfo ENOTFOUND printer.internal']) {
    assert.equal(
      sanitizePrinterError(new Error(message)),
      '打印机连接失败，请检查设备连接和网络设置'
    );
  }
});
