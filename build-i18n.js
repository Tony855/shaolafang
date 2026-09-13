/**
 * languages.js 压缩构建脚本（修复编码）
 */
const fs = require('fs');
const path = require('path');

// 明确指定UTF-8编码读取
const lines = fs.readFileSync(path.join(__dirname, 'languages.js'), 'utf-8').split('\n');

// 中文从第8行(index 7)开始，到en之前(第457行，index 456)
const zhLines = lines.slice(7, 456);
let zhContent = zhLines.join('\n');
zhContent = zhContent.replace(/^\s*zh:\s*\{\n?/, '');
zhContent = zhContent.replace(/\n?\s*\}\s*,?\s*$/, '');

// 压缩
zhContent = zhContent.replace(/\/\/[^\n]*/g, '');
zhContent = zhContent.replace(/\s+/g, ' ');
zhContent = zhContent.replace(/\s*([:,{}])\s*/g, '$1');
zhContent = zhContent.trim();

const minContent = `/* FoodFlow i18n - compressed (zh only) */window.LANGUAGES={zh:{${zhContent}}};`;

// 明确指定UTF-8编码写入
fs.writeFileSync(path.join(__dirname, 'languages.min.js'), minContent, 'utf-8');

const originalSize = fs.statSync(path.join(__dirname, 'languages.js')).size;
const minSize = Buffer.byteLength(minContent, 'utf-8');
console.log(`✅ languages.min.js 已生成`);
console.log(`   原始大小: ${(originalSize / 1024).toFixed(1)} KB`);
console.log(`   压缩大小: ${(minSize / 1024).toFixed(1)} KB`);
console.log(`   减少: ${((1 - minSize / originalSize) * 100).toFixed(1)}%`);

// 验证中文
if (minContent.includes('中文')) {
    console.log('   ✅ 中文编码正确');
} else {
    console.log('   ❌ 中文编码错误');
}
