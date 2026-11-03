'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jimpModule = require('jimp');
const Jimp = jimpModule.Jimp || jimpModule;
const QRCode = require('qrcode');
const { decodeQRFromImage } = require('../server/services/qr-image');
const { compressImage } = require('../server/services/image-compress');

test('QR image decoder round-trips a generated QR code with Jimp 1.x', async () => {
  const payload = 'FOODFLOW-QA-SMOKE-2026';
  const buffer = await QRCode.toBuffer(payload, { type: 'png', width: 320, margin: 2 });
  assert.equal(await decodeQRFromImage(buffer), payload);
});

test('image compression resizes large uploads and atomically writes a smaller JPEG', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-image-smoke-'));
  try {
    const image = new Jimp({ width: 512, height: 512, color: 0xffffffff });
    let state = 0x12345678;
    for (let i = 0; i < image.bitmap.data.length; i += 4) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const pixel = state & 255;
      image.bitmap.data[i] = pixel;
      image.bitmap.data[i + 1] = (pixel * 7) & 255;
      image.bitmap.data[i + 2] = (pixel * 13) & 255;
      image.bitmap.data[i + 3] = 255;
    }

    const inputPath = path.join(tempDir, 'source.png');
    fs.writeFileSync(inputPath, await image.getBuffer('image/png'));
    const result = await compressImage(inputPath, { maxDim: 256, quality: 70 });

    assert.equal(result.skipped, false);
    assert.ok(fs.existsSync(result.outPath));
    assert.ok(!fs.existsSync(inputPath), 'original PNG should be removed only after successful replacement');
    const output = await Jimp.read(result.outPath);
    assert.ok(output.bitmap.width <= 256 && output.bitmap.height <= 256);
    assert.ok(result.compressedSize < result.originalSize);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
