'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const khqr = require('../server/services/khqr');

function tlv(tag, value) {
  const text = String(value);
  return tag + String(text.length).padStart(2, '0') + text;
}

function staticKhqrWithTimestamp() {
  const body = [
    tlv('00', '01'),
    tlv('01', '11'),
    tlv('29', tlv('00', 'test_bakong@devb')),
    tlv('52', '5999'),
    tlv('53', '116'),
    tlv('58', 'KH'),
    tlv('59', 'Lucky Supermarket'),
    tlv('60', 'Phnom Penh'),
    tlv('99', tlv('00', '1700000000000'))
  ].join('');
  return body + '6304' + khqr.crc16(body + '6304');
}

test('dynamic KHQR replaces the static Tag 99 with one standard millisecond timestamp', () => {
  const staticPayload = staticKhqrWithTimestamp();
  assert.equal(khqr.validateCrc(staticPayload), true);
  assert.equal(khqr.parseTLV(staticPayload).filter(item => item.tag === '99').length, 1);

  const before = Date.now();
  const dynamicPayload = khqr.buildDynamicPayload(staticPayload, 12.34, 'USD', 'ORDER-123');
  const after = Date.now();
  const fields = khqr.parseTLV(dynamicPayload);
  const tag99 = fields.filter(item => item.tag === '99');

  assert.equal(tag99.length, 1, 'must not duplicate the source static Tag 99');
  const tag99Fields = khqr.parseTLV(tag99[0].value);
  assert.equal(tag99Fields.length, 1, 'Tag 99 must contain only the standard timestamp subtag');
  assert.equal(tag99Fields[0].tag, '00');
  assert.match(tag99Fields[0].value, /^\d{13}$/, 'Tag 99 subtag 00 must contain a millisecond timestamp');
  assert.ok(Number(tag99Fields[0].value) >= before && Number(tag99Fields[0].value) <= after);
  assert.equal(fields.find(item => item.tag === '01')?.value, '12');
  assert.equal(fields.find(item => item.tag === '53')?.value, '840');
  assert.equal(fields.find(item => item.tag === '54')?.value, '12.34');
  assert.equal(khqr.validateCrc(dynamicPayload), true);

  const additionalData = fields.find(item => item.tag === '62');
  assert.ok(additionalData);
  const additionalFields = khqr.parseTLV(additionalData.value);
  assert.equal(additionalFields.find(item => item.tag === '01')?.value, 'ORDER-123');
  assert.equal(additionalFields.find(item => item.tag === '08')?.value, 'Order ORDER-123');
});

test('dynamic KHQR emits Tag 99 even when the static payload omitted it', () => {
  const fields = [
    tlv('00', '01'),
    tlv('01', '11'),
    tlv('29', tlv('00', 'test_bakong@devb')),
    tlv('52', '5999'),
    tlv('53', '116'),
    tlv('58', 'KH'),
    tlv('59', 'Lucky Supermarket'),
    tlv('60', 'Phnom Penh')
  ];
  const body = fields.join('');
  const staticPayload = body + '6304' + khqr.crc16(body + '6304');
  const dynamicPayload = khqr.buildDynamicPayload(staticPayload, 1000, 'KHR', 'ORDER-456');
  const parsed = khqr.parseTLV(dynamicPayload);

  assert.equal(parsed.filter(item => item.tag === '99').length, 1);
  const tag99Fields = khqr.parseTLV(parsed.find(item => item.tag === '99').value);
  assert.equal(tag99Fields.length, 1);
  assert.equal(tag99Fields[0].tag, '00');
  assert.match(tag99Fields[0].value, /^\d{13}$/);
  assert.equal(parsed.find(item => item.tag === '54')?.value, '1000');
  assert.equal(parsed.find(item => item.tag === '53')?.value, '116');
  assert.equal(khqr.validateCrc(dynamicPayload), true);
});
