'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function source(...parts) {
  return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
}

test('cashier and waiter close only cancel a QR they actually received', () => {
  for (const file of [
    ['pages', 'cashier.js'],
    ['pages', 'waiter-payment.js']
  ]) {
    const text = source(...file);
    assert.ok(text.includes('if (orderId && qrPayload && qrGenerationId)'));
    assert.ok(text.includes('expected_qr_ref: qrPayload'));
    assert.ok(text.includes('expected_qr_generation_id: qrGenerationId'));
    assert.ok(text.includes('expected_qr_ref: res.qr_payload'));
    assert.ok(text.includes('expected_qr_generation_id: res.qr_generation_id'));
    assert.ok(text.includes('Do not send an unqualified cancel while QR generation is pending') ||
      text.includes('If generation is still pending, do not send an unqualified cancel'));
  }
});

test('currency switching cancels the exact current QR before requesting the new currency', () => {
  for (const file of [
    ['pages', 'cashier.js'],
    ['pages', 'waiter-payment.js']
  ]) {
    const text = source(...file);
    assert.ok(text.includes('if (window.__khqrSwitchBusy || !khqrState.qrPayload || !khqrState.qrGenerationId) return;'));
    assert.ok(text.includes('body: { order_id: orderId, expected_qr_ref: currentQr, expected_qr_generation_id: khqrState.qrGenerationId }'));
    assert.ok(text.includes('openKhqrModal(orderId, providerId, nextCurrency);'));
    assert.ok(text.includes('sw.disabled = true;'));
    assert.ok(text.includes('currencySwitch.disabled = !khqrState.qrPayload || !khqrState.qrGenerationId;'));
  }
});
