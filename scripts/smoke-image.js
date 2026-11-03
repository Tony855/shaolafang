'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jimpModule = require('jimp');
const Jimp = jimpModule.Jimp || jimpModule;
const QRCode = require('qrcode');
const { decodeQRFromImage } = require('../server/services/qr-image');
const { compressImage } = require('../server/services/image-compress');

async function main() {
  const qrText = 'FOODFLOW-QA-SMOKE-2026';
  const qrBuffer = await QRCode.toBuffer(qrText, { type: 'png', width: 320, margin: 2 });
  const decoded = await decodeQRFromImage(qrBuffer);
  assert.strictEqual(decoded, qrText, 'Jimp + jsQR QR decode must round-trip');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-image-smoke-'));
  try {
    const image = new Jimp({ width: 512, height: 512, color: 0xffffffff });
    for (let i = 0; i < image.bitmap.data.length; i += 4) {
      const pixel = (i * 37 + Math.floor(i / 4) * 19) & 255;
      image.bitmap.data[i] = pixel;
      image.bitmap.data[i + 1] = (pixel * 7) & 255;
      image.bitmap.data[i + 2] = (pixel * 13) & 255;
      image.bitmap.data[i + 3] = 255;
    }
    const inputPath = path.join(tempDir, 'source.png');
    fs.writeFileSync(inputPath, await image.getBuffer('image/png'));
    const result = await compressImage(inputPath, { maxDim: 256, quality: 70 });
    assert.strictEqual(result.skipped, false, 'large image should be compressed');
    assert(fs.existsSync(result.outPath), 'compressed output must exist');
    const output = await Jimp.read(result.outPath);
    assert(output.bitmap.width <= 256 && output.bitmap.height <= 256, 'compressed image must respect max dimension');
    assert(result.compressedSize < result.originalSize, 'compressed image must be smaller than source');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  process.stdout.write('Image and QR smoke tests passed.\\n');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
