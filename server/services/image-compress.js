/*
 * server/services/image-compress.js — 上传图片后端兜底压缩
 * 用途：前端 canvas 压缩失败 / 直接调 API 上传 / 上传超大 GIF 时，兜底压到合理尺寸
 * 策略：长边 > maxDim 时等比缩到 maxDim，JPEG 质量 85
 */
const fs = require('fs');
const path = require('path');
const _jimpMod = require('jimp');
const Jimp = _jimpMod.Jimp || _jimpMod;

async function readImage(bufferOrPath) {
    if (typeof Jimp.read === 'function') return await Jimp.read(bufferOrPath);
    if (typeof Jimp.fromBuffer === 'function' && Buffer.isBuffer(bufferOrPath)) {
        return await Jimp.fromBuffer(bufferOrPath);
    }
    throw new Error('jimp API 不兼容');
}

/**
 * 压缩单个图片文件（覆盖原文件）
 * @param {string} filePath 图片绝对路径
 * @param {object} opts { maxDim=1200, quality=85 }
 * @returns {Promise<{originalSize, compressedSize, skipped}>}
 */
async function compressImage(filePath, opts) {
    opts = opts || {};
    const maxDim = opts.maxDim || 1200;
    const quality = opts.quality || 85;

    if (!fs.existsSync(filePath)) {
        return { skipped: true, reason: 'file not found' };
    }
    const originalSize = fs.statSync(filePath).size;

    const ext = path.extname(filePath).toLowerCase();
    // GIF 不动（保持动图）
    if (ext === '.gif') {
        return { skipped: true, reason: 'gif not compressed', originalSize };
    }

    // 小于 100KB 不压（已经够小）
    if (originalSize < 100 * 1024) {
        return { skipped: true, reason: 'small enough', originalSize };
    }

    try {
        const img = await readImage(filePath);
        const w = img.bitmap.width;
        const h = img.bitmap.height;

        // Jimp 1.x 已移除 AUTO 和 quality()；旧版仍保留原 positional API。
        if (w > maxDim || h > maxDim) {
            if (Jimp.AUTO !== undefined) {
                if (w >= h) img.resize(maxDim, Jimp.AUTO);
                else img.resize(Jimp.AUTO, maxDim);
            } else if (w >= h) {
                img.resize({ w: maxDim });
            } else {
                img.resize({ h: maxDim });
            }
        }

        // 使用 Jimp 1.x 的编码 options；写临时文件，确认变小后再原子替换原图。
        const outPath = filePath.replace(/\.(png|webp|jpeg|jpg)$/i, '.jpg');
        let encoded;
        if (typeof img.getBuffer === 'function') {
            encoded = await img.getBuffer('image/jpeg', { quality });
        } else {
            if (typeof img.quality === 'function') img.quality(quality);
            const jpegMime = Jimp.MIME_JPEG || 'image/jpeg';
            if (typeof img.getBufferAsync === 'function') encoded = await img.getBufferAsync(jpegMime);
            else throw new Error('当前 Jimp 版本不支持 JPEG 编码');
        }
        if (!Buffer.isBuffer(encoded) || encoded.length === 0) throw new Error('图片编码结果为空');

        const tempPath = outPath.replace(/\.jpg$/i, '.tmp-' + Date.now() + '.jpg');
        fs.writeFileSync(tempPath, encoded, { mode: 0o640 });
        const compressedSize = fs.statSync(tempPath).size;
        if (compressedSize >= originalSize) {
            fs.unlinkSync(tempPath);
            return { skipped: true, reason: 'compressed image is not smaller', originalSize, compressedSize };
        }

        fs.renameSync(tempPath, outPath);
        if (outPath !== filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);

        return {
            skipped: false,
            originalSize,
            compressedSize,
            saved: originalSize - compressedSize,
            outPath
        };
    } catch (e) {
        console.warn('[image-compress] 压缩失败，保留原文件:', filePath, e.message);
        return { skipped: true, reason: e.message, originalSize };
    }
}

module.exports = { compressImage };
