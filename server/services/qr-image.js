/* ============================================================
   server/services/qr-image.js — 通用二维码图片解码
   KHQR / VietQR / 未来其它 QR 共用
   ============================================================ */
'use strict';

const _jimpMod = require('jimp');
const Jimp = _jimpMod.Jimp || _jimpMod;
const jsQR = require('jsqr');

async function _readImage(buffer) {
  if (typeof Jimp.read === 'function') return await Jimp.read(buffer);
  if (typeof Jimp.fromBuffer === 'function') return await Jimp.fromBuffer(buffer);
  throw new Error('Jimp API 不兼容');
}

/**
 * 从图片 Buffer 解码二维码 payload 字符串
 * @param {Buffer} buffer - 图片二进制
 * @returns {Promise<string>} 二维码 payload
 */
async function decodeQRFromImage(buffer) {
  const image = await _readImage(buffer);
  const { data, width, height } = image.bitmap;
  const pixels = new Uint8ClampedArray(data.buffer || data);
  const result = jsQR(pixels, width, height);
  if (!result) throw new Error('未识别到二维码，请上传清晰的二维码图片');
  return result.data;
}

module.exports = { decodeQRFromImage };
