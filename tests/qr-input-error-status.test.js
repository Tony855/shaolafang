'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const QRCode = require('qrcode');
const { decodeQRFromImage } = require('../server/services/qr-image');
const { parseAnyQR } = require('../server/services/qr-detect');

test('unreadable QR image is classified as a client input error', async () => {
  await assert.rejects(
    decodeQRFromImage(Buffer.from('not an image')),
    error => error.status === 400 && error.message === '图片无法解析或格式不受支持'
  );
});

test('unsupported QR payload is classified as a client input error', async () => {
  const image = await QRCode.toBuffer('not KHQR and not VietQR');
  await assert.rejects(
    parseAnyQR(image),
    error => error.status === 400 && error.message === '二维码既不是 KHQR 也不是 VietQR'
  );
});
