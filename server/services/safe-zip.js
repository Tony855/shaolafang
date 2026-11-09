'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable, Transform, Writable } = require('stream');
const { pipeline } = require('stream/promises');

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_EOCD_SEARCH = 22 + 0xffff;

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c >>> 0;
}

function crc32Update(crc, buffer) {
  let value = crc >>> 0;
  for (let i = 0; i < buffer.length; i++) value = crcTable[(value ^ buffer[i]) & 0xff] ^ (value >>> 8);
  return value >>> 0;
}

function readAt(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (!count) throw new Error('ZIP 文件结构不完整');
    offset += count;
  }
  return buffer;
}

function openZipArchive(zipPath, options = {}) {
  const maxEntries = options.maxEntries || 2000;
  const stat = fs.statSync(zipPath);
  if (!stat.isFile() || stat.size < 22) throw new Error('ZIP 文件无效');
  const fd = fs.openSync(zipPath, 'r');
  try {
    const tailLength = Math.min(stat.size, MAX_EOCD_SEARCH);
    const tailOffset = stat.size - tailLength;
    const tail = readAt(fd, tailLength, tailOffset);
    let eocdIndex = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== EOCD) continue;
      const commentLength = tail.readUInt16LE(i + 20);
      if (i + 22 + commentLength === tail.length) { eocdIndex = i; break; }
    }
    if (eocdIndex < 0) throw new Error('ZIP 中央目录结束记录缺失');
    const eocd = tail.subarray(eocdIndex);
    const diskNumber = eocd.readUInt16LE(4);
    const centralDisk = eocd.readUInt16LE(6);
    const diskEntries = eocd.readUInt16LE(8);
    const totalEntries = eocd.readUInt16LE(10);
    const centralSize = eocd.readUInt32LE(12);
    const centralOffset = eocd.readUInt32LE(16);
    const eocdAbsolute = tailOffset + eocdIndex;
    if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
      throw new Error('不支持分卷 ZIP 文件');
    }
    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 文件');
    }
    if (totalEntries > maxEntries) throw Object.assign(new Error('ZIP 文件条目数量超过限制'), { status: 413 });
    if (centralSize > 4 * 1024 * 1024) throw Object.assign(new Error('ZIP 中央目录超过限制'), { status: 413 });
    if (centralOffset + centralSize > eocdAbsolute || centralOffset < 0) throw new Error('ZIP 中央目录越界');
    const central = readAt(fd, centralSize, centralOffset);
    const entries = [];
    let cursor = 0;
    const names = new Set();
    for (let index = 0; index < totalEntries; index++) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL) throw new Error('ZIP 中央目录条目损坏');
      const flags = central.readUInt16LE(cursor + 8);
      const method = central.readUInt16LE(cursor + 10);
      const crc = central.readUInt32LE(cursor + 16);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const startDisk = central.readUInt16LE(cursor + 34);
      const localOffset = central.readUInt32LE(cursor + 42);
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > central.length) throw new Error('ZIP 中央目录条目长度无效');
      if (startDisk !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error('不支持 ZIP64 或分卷条目');
      }
      if ((flags & 0x0001) || (flags & 0x0040)) throw new Error('不支持加密 ZIP 条目');
      if (method !== 0 && method !== 8) throw new Error('ZIP 使用了不支持的压缩算法');
      const nameBuffer = central.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = nameBuffer.toString('utf8');
      if (!name || name.includes('\ufffd') || names.has(name)) throw new Error('ZIP 文件名无效或重复');
      names.add(name);
      if (localOffset + 30 > centralOffset) throw new Error('ZIP 本地文件头越界');
      const local = readAt(fd, 30, localOffset);
      if (local.readUInt32LE(0) !== LOCAL) throw new Error('ZIP 本地文件头损坏');
      const localFlags = local.readUInt16LE(6);
      const localMethod = local.readUInt16LE(8);
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      if ((localFlags & 0x0001) || localMethod !== method) throw new Error('ZIP 本地文件头与中央目录不一致');
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      if (dataStart > centralOffset) throw new Error('ZIP 本地文件头扩展字段越界');
      const localName = readAt(fd, localNameLength, localOffset + 30).toString('utf8');
      if (localName !== name) throw new Error('ZIP 文件名与本地文件头不一致');
      const dataEnd = dataStart + compressedSize;
      if (dataStart < localOffset || dataEnd > centralOffset || dataEnd > stat.size) throw new Error('ZIP 压缩数据越界');
      entries.push({
        entryName: name,
        isDirectory: name.endsWith('/'),
        method,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        dataStart,
        header: { size: uncompressedSize }
      });
      cursor = end;
    }
    if (cursor !== central.length) throw new Error('ZIP 中央目录包含多余或不完整数据');
    return { entries, fileSize: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

async function streamEntry(zipPath, entry, maxBytes, destination) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative safe integer');
  if (entry.isDirectory) throw new Error('不能解压 ZIP 目录条目');
  if (entry.uncompressedSize > maxBytes) throw Object.assign(new Error('ZIP 条目超过实际解压大小限制'), { status: 413 });
  const stat = fs.statSync(zipPath);
  if (entry.dataStart + entry.compressedSize > stat.size) throw new Error('ZIP 条目数据越界');
  const source = entry.compressedSize === 0
    ? Readable.from([])
    : fs.createReadStream(zipPath, { start: entry.dataStart, end: entry.dataStart + entry.compressedSize - 1 });
  const inflater = entry.method === 8 ? zlib.createInflateRaw() : new (require('stream').PassThrough)();
  let bytes = 0;
  let crc = 0xffffffff;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes || bytes > entry.uncompressedSize) {
        return callback(Object.assign(new Error('ZIP 条目实际解压大小超过限制'), { status: 413 }));
      }
      crc = crc32Update(crc, chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(source, inflater, limiter, destination);
    const actualCrc = (crc ^ 0xffffffff) >>> 0;
    if (bytes !== entry.uncompressedSize || actualCrc !== entry.crc32) throw new Error('ZIP 条目大小或 CRC 校验失败');
    return bytes;
  } catch (error) {
    source.destroy();
    inflater.destroy();
    throw error;
  }
}

async function readEntryBuffer(zipPath, entry, maxBytes) {
  const chunks = [];
  const sink = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  await streamEntry(zipPath, entry, maxBytes, sink);
  return Buffer.concat(chunks);
}

async function extractEntryToFile(zipPath, entry, destinationPath, maxBytes) {
  const directory = path.dirname(destinationPath);
  const tempPath = destinationPath + '.tmp-' + crypto.randomBytes(8).toString('hex');
  await fs.promises.mkdir(directory, { recursive: true });
  try {
    const sink = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o640 });
    const bytes = await streamEntry(zipPath, entry, maxBytes, sink);
    await fs.promises.rename(tempPath, destinationPath);
    return bytes;
  } catch (error) {
    try { await fs.promises.unlink(tempPath); } catch (_) {}
    throw error;
  }
}

module.exports = { openZipArchive, readEntryBuffer, extractEntryToFile };
