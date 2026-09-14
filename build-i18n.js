/**
 * languages.js 压缩构建脚本
 * 使用 vm 执行 languages.js 提取中文，避免硬编码行号
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, 'languages.js'), 'utf-8');
const sandbox = { module: {}, exports: {} };
const context = vm.createContext(sandbox);
vm.runInContext(source + '; this._result = LANGUAGES.zh;', context);
const zhDict = sandbox._result || {};

// 压缩为单行JSON
const minContent = '/* FoodFlow i18n - compressed (zh only) */window.LANGUAGES={zh:' + JSON.stringify(zhDict) + '};';

fs.writeFileSync(path.join(__dirname, 'languages.min.js'), minContent, 'utf-8');

const originalSize = fs.statSync(path.join(__dirname, 'languages.js')).size;
const minSize = Buffer.byteLength(minContent, 'utf-8');
console.log('languages.min.js 已生成');
console.log('  原始大小:', (originalSize / 1024).toFixed(1), 'KB');
console.log('  压缩大小:', (minSize / 1024).toFixed(1), 'KB');
console.log('  减少:', ((1 - minSize / originalSize) * 100).toFixed(1) + '%');
console.log('  中文键数:', Object.keys(zhDict).length);

// 验证关键键
if (zhDict.merchantUpdated) {
    console.log('  merchantUpdated:', zhDict.merchantUpdated);
} else {
    console.log('  WARNING: merchantUpdated missing!');
}
