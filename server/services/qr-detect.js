/* ============================================================
   server/services/qr-detect.js — 通用二维码解析分派
   自动判断 KHQR / VietQR 并返回统一结构
   ============================================================ */
'use strict';

const { decodeQRFromImage } = require('./qr-image');
const { parseStaticPayload } = require('./khqr');
const { parseVietQR } = require('./vietqr/vietqr-parser');

/**
 * 从图片 Buffer 自动识别并解析
 * @param {Buffer} buffer
 * @returns {Promise<Object>} { country: 'KH'|'VN', kind: 'KHQR'|'VIETQR', ... }
 */
async function parseAnyQR(buffer) {
  const payload = await decodeQRFromImage(buffer);

  // 1. 试 VietQR：NAPAS GUID 特征非常明显
  let vietqr = null;
  try {
    const p = parseVietQR(payload);
    if (p.format === 'VIETQR_NAPAS' && p.crc.valid === true) {
      vietqr = p;
    }
  } catch (_) {}

  if (vietqr) {
    return {
      country: 'VN',
      kind: 'VIETQR',
      payload,
      bankBin: vietqr.bank.bin,
      bankAccount: vietqr.bank.accountNumber,
      serviceCode: vietqr.bank.serviceCode,
      merchantName: vietqr.merchantName,
      currency: vietqr.payment.currency,
      qrType: vietqr.qrType,
      raw: vietqr,
    };
  }

  // 2. 试 KHQR
  let khqr = null;
  try {
    khqr = parseStaticPayload(payload);
  } catch (e) {
    throw new Error('二维码既不是 KHQR 也不是 VietQR：' + e.message);
  }

  return {
    country: 'KH',
    kind: 'KHQR',
    payload,
    bakongId: khqr.bakongId,
    merchantName: khqr.merchantName,
    currency: khqr.currency,
    qrType: khqr.info.pointOfInit === '12' ? 'DYNAMIC' : 'STATIC',
    raw: khqr,
  };
}

module.exports = { parseAnyQR };
