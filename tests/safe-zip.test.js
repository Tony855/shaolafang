'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { openZipArchive, readEntryBuffer, extractEntryToFile } = require('../server/services/safe-zip');

function createArchive(entries) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foodflow-safe-zip-'));
  const filePath = path.join(directory, 'test.zip');
  const zip = new AdmZip();
  for (const [name, value] of Object.entries(entries)) zip.addFile(name, Buffer.from(value));
  zip.writeZip(filePath);
  return { directory, filePath };
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

test('bounded ZIP reader parses entries and verifies CRC before returning content', async () => {
  const fixture = createArchive({ 'menu.json': '{"format":"foodflow-menu","version":1}', 'images/photo.jpg': 'image-data' });
  try {
    const archive = openZipArchive(fixture.filePath);
    assert.equal(archive.entries.length, 2);
    const menu = archive.entries.find(entry => entry.entryName === 'menu.json');
    assert.equal((await readEntryBuffer(fixture.filePath, menu, 1024)).toString(), '{"format":"foodflow-menu","version":1}');
    const image = archive.entries.find(entry => entry.entryName === 'images/photo.jpg');
    const destination = path.join(fixture.directory, 'out', 'photo.jpg');
    assert.equal(await extractEntryToFile(fixture.filePath, image, destination, 1024), 10);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'image-data');
  } finally {
    cleanup(fixture.directory);
  }
});

test('ZIP entry decompression is stopped when actual output exceeds its declared size', async () => {
  const fixture = createArchive({ 'menu.json': 'A'.repeat(256 * 1024) });
  try {
    const fd = fs.openSync(fixture.filePath, 'r+');
    try {
      const stat = fs.fstatSync(fd);
      const tailLength = Math.min(stat.size, 22 + 0xffff);
      const tail = Buffer.alloc(tailLength);
      fs.readSync(fd, tail, 0, tailLength, stat.size - tailLength);
      let eocd = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
      }
      assert.notEqual(eocd, -1);
      const centralOffset = tail.readUInt32LE(eocd + 16);
      const declaredSize = Buffer.alloc(4);
      declaredSize.writeUInt32LE(1);
      fs.writeSync(fd, declaredSize, 0, 4, centralOffset + 24);
    } finally {
      fs.closeSync(fd);
    }
    const archive = openZipArchive(fixture.filePath);
    const entry = archive.entries[0];
    assert.equal(entry.uncompressedSize, 1);
    await assert.rejects(readEntryBuffer(fixture.filePath, entry, 1024), /实际解压大小超过限制/);
  } finally {
    cleanup(fixture.directory);
  }
});

test('ZIP CRC mismatch is rejected and partial extracted files are removed', async () => {
  const fixture = createArchive({ 'images/photo.jpg': 'image-data' });
  try {
    const fd = fs.openSync(fixture.filePath, 'r+');
    try {
      const stat = fs.fstatSync(fd);
      const tailLength = Math.min(stat.size, 22 + 0xffff);
      const tail = Buffer.alloc(tailLength);
      fs.readSync(fd, tail, 0, tailLength, stat.size - tailLength);
      let eocd = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
      }
      const centralOffset = tail.readUInt32LE(eocd + 16);
      const badCrc = Buffer.alloc(4);
      badCrc.writeUInt32LE(0);
      fs.writeSync(fd, badCrc, 0, 4, centralOffset + 16);
    } finally {
      fs.closeSync(fd);
    }
    const archive = openZipArchive(fixture.filePath);
    const destination = path.join(fixture.directory, 'out', 'photo.jpg');
    await assert.rejects(extractEntryToFile(fixture.filePath, archive.entries[0], destination, 1024), /CRC 校验失败/);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.readdirSync(path.join(fixture.directory, 'out')).length, 0);
  } finally {
    cleanup(fixture.directory);
  }
});

test('ZIP parser rejects encrypted, multi-disk and ZIP64 metadata', () => {
  const fixture = createArchive({ 'menu.json': '{}' });
  try {
    const fd = fs.openSync(fixture.filePath, 'r+');
    try {
      const stat = fs.fstatSync(fd);
      const tail = Buffer.alloc(Math.min(stat.size, 22 + 0xffff));
      fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
      let eocd = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
      }
      const centralOffset = tail.readUInt32LE(eocd + 16);
      const encryptedFlags = Buffer.alloc(2);
      encryptedFlags.writeUInt16LE(1);
      fs.writeSync(fd, encryptedFlags, 0, 2, centralOffset + 8);
    } finally {
      fs.closeSync(fd);
    }
    assert.throws(() => openZipArchive(fixture.filePath), /加密 ZIP 条目/);
  } finally {
    cleanup(fixture.directory);
  }
});
