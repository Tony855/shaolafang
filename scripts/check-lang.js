#!/usr/bin/env node
/**
 * ============================================================
 *  语言包一致性检查
 *
 *  检查项：
 *   1. 各语言是否都存在于 zh/en/vi/th/km
 *   2. key 集合是否与 zh 基准一致（缺失/多余）
 *   3. categories 子对象的 key 是否一致
 *   4. 检测明显的"跨语言污染"：把整个 value 与其它语言的同名 key 比对，
 *      若完全一致且 value 是长文本（>=3 字符）则告警
 *   5. 值是否为空字符串
 *
 *  用法：
 *   node scripts/check-lang.js          # 完整校验
 *   node scripts/check-lang.js --strict # 有告警即 exit 1
 * ============================================================
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const LANGS_FILE = path.join(ROOT, 'languages.js');
const STRICT = process.argv.includes('--strict');

const EXPECTED_LANGS = ['zh', 'en', 'vi', 'th', 'km'];
const BASE_LANG = 'zh';

// ---------- 加载 languages.js ----------
function loadLanguages() {
  const code = fs.readFileSync(LANGS_FILE, 'utf8');
  const sandbox = { module: { exports: {} }, exports: {}, console, window: {} };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const langs = sandbox.LANGUAGES || (sandbox.window && sandbox.window.LANGUAGES);
  if (!langs) throw new Error('无法从 languages.js 提取 LANGUAGES');
  return langs;
}

// ---------- 检查主流程 ----------
function check(L) {
  const errors = [];
  const warnings = [];

  // 1. 语言存在性
  for (const lang of EXPECTED_LANGS) {
    if (!L[lang]) errors.push(`缺少语言: ${lang}`);
  }
  if (errors.length) return { errors, warnings };

  // 2. key 集合对比（与 zh 基准）
  const baseKeys = new Set(
    Object.keys(L[BASE_LANG]).filter(k => k !== 'categories')
  );
  for (const lang of EXPECTED_LANGS) {
    if (lang === BASE_LANG) continue;
    const keys = new Set(Object.keys(L[lang]).filter(k => k !== 'categories'));
    const missing = [...baseKeys].filter(k => !keys.has(k));
    const extra = [...keys].filter(k => !baseKeys.has(k));
    if (missing.length) {
      errors.push(`[${lang}] 缺失 ${missing.length} 个 key: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' ...' : ''}`);
    }
    if (extra.length) {
      warnings.push(`[${lang}] 多余 ${extra.length} 个 key: ${extra.slice(0, 10).join(', ')}${extra.length > 10 ? ' ...' : ''}`);
    }
  }

  // 3. categories 子对象一致性
  const baseCats = new Set(Object.keys(L[BASE_LANG].categories || {}));
  for (const lang of EXPECTED_LANGS) {
    if (lang === BASE_LANG) continue;
    const cats = new Set(Object.keys(L[lang].categories || {}));
    const missing = [...baseCats].filter(c => !cats.has(c));
    const extra = [...cats].filter(c => !baseCats.has(c));
    if (missing.length) errors.push(`[${lang}.categories] 缺失: ${missing.join(', ')}`);
    if (extra.length) warnings.push(`[${lang}.categories] 多余: ${extra.join(', ')}`);
  }

  // 4. 跨语言污染检测：值是否与其它语言的同名 key 完全一致
  for (const lang of EXPECTED_LANGS) {
    for (const key of Object.keys(L[lang])) {
      if (key === 'categories') continue;
      const val = L[lang][key];
      if (typeof val !== 'string' || val.length < 3) continue;

      // 跳过品牌类/占位符
      if (/^(FoodFlow|Login to FoodFlow|http)/.test(val)) continue;
      // 跳过纯符号/数字
      if (!/[\u4e00-\u9fa5\u0100-\u01ff\u0e00-\u0e7f\u1780-\u17ff\w]/.test(val)) continue;

      for (const otherLang of EXPECTED_LANGS) {
        if (otherLang === lang) continue;
        if (L[otherLang] && L[otherLang][key] === val) {
          warnings.push(`跨语言污染: [${lang}.${key}] 与 [${otherLang}.${key}] 值相同 → "${val}"`);
        }
      }
    }
  }

  // 5. 空值检查
  for (const lang of EXPECTED_LANGS) {
    for (const key of Object.keys(L[lang])) {
      if (key === 'categories') continue;
      const val = L[lang][key];
      if (val === '' || val === null || val === undefined) {
        warnings.push(`[${lang}.${key}] 值为空`);
      }
    }
  }

  return { errors, warnings };
}

// ---------- 主入口 ----------
try {
  const L = loadLanguages();
  const { errors, warnings } = check(L);

  console.log('🔎 语言包一致性检查\n');

  if (errors.length) {
    console.log(`❌ 错误 (${errors.length}):`);
    errors.forEach(e => console.log('   ' + e));
    console.log('');
  }

  if (warnings.length) {
    console.log(`⚠️  告警 (${warnings.length}):`);
    warnings.slice(0, 30).forEach(w => console.log('   ' + w));
    if (warnings.length > 30) console.log(`   ... 还有 ${warnings.length - 30} 条`);
    console.log('');
  }

  if (!errors.length && !warnings.length) {
    console.log('✅ 全部通过');
  }

  // exit code
  if (errors.length) process.exit(1);
  if (STRICT && warnings.length) process.exit(1);

  console.log('\n📊 各语言 key 数量:');
  for (const lang of EXPECTED_LANGS) {
    if (!L[lang]) continue;
    const n = Object.keys(L[lang]).filter(k => k !== 'categories').length;
    const c = Object.keys(L[lang].categories || {}).length;
    console.log(`   ${lang}: 顶层 ${n}, categories ${c}`);
  }
} catch (e) {
  console.error('❌ 检查失败:', e.message);
  process.exit(2);
}