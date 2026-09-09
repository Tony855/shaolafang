const fs = require('fs');

// 读取 languages.js
const content = fs.readFileSync('languages.js', 'utf-8');

// 提取 LANGUAGES 对象
// 简单的方法：用 eval 或手动解析
// 由于是 JS 文件，我们用 vm 来执行
const vm = require('vm');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(content + '\nthis.LANGUAGES = LANGUAGES;', sandbox);

const LANGUAGES = sandbox.LANGUAGES;

console.log('=== 语言列表 ===');
Object.keys(LANGUAGES).forEach(code => {
  console.log(`${code}: ${LANGUAGES[code].name}`);
});

// 获取所有翻译键（以英文为基准，或者以中文为基准）
// 先看看哪个语言的键最多
const allKeys = {};
Object.keys(LANGUAGES).forEach(code => {
  Object.keys(LANGUAGES[code]).forEach(key => {
    if (!allKeys[key]) allKeys[key] = [];
    allKeys[key].push(code);
  });
});

console.log('\n=== 翻译键统计 ===');
console.log(`总键数（所有语言合并）: ${Object.keys(allKeys).length}`);

Object.keys(LANGUAGES).forEach(code => {
  const langKeys = Object.keys(LANGUAGES[code]);
  console.log(`${code} (${LANGUAGES[code].name}): ${langKeys.length} 个键`);
});

// 找出缺失的键
console.log('\n=== 缺失翻译键分析 ===');
const baseLang = 'en'; // 以英文为基准
const baseKeys = new Set(Object.keys(LANGUAGES[baseLang]));

Object.keys(LANGUAGES).forEach(code => {
  if (code === baseLang) return;
  const langKeys = new Set(Object.keys(LANGUAGES[code]));
  const missing = [...baseKeys].filter(k => !langKeys.has(k));
  const extra = [...langKeys].filter(k => !baseKeys.has(k));
  if (missing.length > 0) {
    console.log(`\n${code} 缺失 ${missing.length} 个键:`);
    missing.forEach(k => console.log(`  - ${k}: "${LANGUAGES[baseLang][k]}"`));
  }
  if (extra.length > 0) {
    console.log(`\n${code} 多出 ${extra.length} 个键（英文中没有）:`);
    extra.forEach(k => console.log(`  - ${k}: "${LANGUAGES[code][k]}"`));
  }
});

// 检查空值翻译
console.log('\n=== 空值翻译检查 ===');
Object.keys(LANGUAGES).forEach(code => {
  const emptyKeys = Object.keys(LANGUAGES[code]).filter(k => {
    const v = LANGUAGES[code][k];
    return v === '' || v === null || v === undefined;
  });
  if (emptyKeys.length > 0) {
    console.log(`${code} 有 ${emptyKeys.length} 个空值: ${emptyKeys.join(', ')}`);
  }
});
