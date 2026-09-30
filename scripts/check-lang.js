#!/usr/bin/env node
/**
 * ============================================================
 *  check-lang.js - 语言包一致性检查（数据源 locales/*.json）
 *
 *  检查项：
 *   1. 5 个语言文件是否存在且为合法 JSON（error，阻断）
 *   2. key 集合是否与 zh 基准一致（缺失/多余，warning）
 *   3. categories 子对象 key 是否一致（warning）
 *   4. 空字符串 / null 值（warning）
 *   5. en/vi/th/km 中是否有中文残留（warning）
 *   6. 跨语言值完全雷同污染（warning）
 *
 *  用法：
 *   node scripts/check-lang.js            # 硬错误 exit 1，告警不阻断
 *   node scripts/check-lang.js --strict   # 有告警也 exit 1
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'locales');
const EXPECTED_LANGS = ['zh', 'en', 'vi', 'th', 'km'];
const BASE_LANG = 'zh';
const STRICT = process.argv.includes('--strict');
const CHECK_DUP = process.argv.includes('--check-dup');
const HAS_CHINESE = /[\u4e00-\u9fa5]/;

/* ===== 白名单：这些 key / 值即便跨语言相同也不算问题 ===== */
const SAME_OK_KEYS = new Set([
  // 品牌标题（5 语言相同）
  'title',
  // 打印机品牌（全球统一写法）
  'epson', 'bixolon', 'rongta', 'xprinter', 'star', 'jiabo', 'hoin',
  // 技术术语（无需翻译）
  'qrCode', 'cpuUsage',
  // 品牌标识（各类品牌名/口号）
  'appName', 'appNameFull', 'brand', 'brandName',
  'adminBrand', 'adminBrandFull', 'loginToBrand', 'headerTitle',
]);
const SAME_OK_VALUES = new Set([
  'EPSON', 'Bixolon', 'Rongta', 'Xprinter', 'Star', 'Gprinter', 'Hoin',
  'QR Code', 'CPU',
]);

/* 加载 JSON，文件缺失/语法错误作为硬错误抛出 */
function loadLocales() {
  const result = {};
  for (const lang of EXPECTED_LANGS) {
    const file = path.join(LOCALES_DIR, lang + '.json');
    if (!fs.existsSync(file)) throw new Error('缺少语言文件: locales/' + lang + '.json');
    result[lang] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return result;
}

/* 递归收集所有叶子 key 路径（含 categories.xxx） */
function collectLeaves(obj, prefix) {
  const leaves = {};
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const pathKey = prefix ? prefix + '.' + key : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(leaves, collectLeaves(val, pathKey));
    } else {
      leaves[pathKey] = val;
    }
  }
  return leaves;
}

function check(L) {
  const errors = [];
  const warnings = [];

  const baseLeaves = collectLeaves(L[BASE_LANG], '');
  const baseKeys = new Set(Object.keys(baseLeaves));

  for (const lang of EXPECTED_LANGS) {
    if (lang === BASE_LANG) continue;
    const leaves = collectLeaves(L[lang], '');
    const keys = new Set(Object.keys(leaves));

    // 1. key 缺失 / 多余
    const missing = [...baseKeys].filter(k => !keys.has(k));
    const extra = [...keys].filter(k => !baseKeys.has(k));
    if (missing.length) {
      warnings.push(`[${lang}] 缺失 ${missing.length} 个 key: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' ...' : ''}`);
    }
    if (extra.length) {
      warnings.push(`[${lang}] 多余 ${extra.length} 个 key: ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ' ...' : ''}`);
    }

    // 2. 空值
    for (const [k, v] of Object.entries(leaves)) {
      if (v === '' || v === null || v === undefined) {
        warnings.push(`[${lang}.${k}] 值为空`);
      }
    }

    // 3. 非中文语言的中文残留
    for (const [k, v] of Object.entries(leaves)) {
      if (typeof v === 'string' && HAS_CHINESE.test(v)) {
        warnings.push(`[${lang}.${k}] 含中文残留: "${v.slice(0, 20)}"`);
      }
    }
  }

  // 4. 跨语言雷同污染（仅顶层字符串，长度>=3，排除品牌/URL）
  //    默认不检查：品牌名/技术缩写/未翻译都会命中，误报率高
  //    需要时用 --check-dup 显式启用
  if (CHECK_DUP) for (const key of baseKeys) {
    if (key.includes('.')) continue;
    if (SAME_OK_KEYS.has(key)) continue;
    const vals = {};
    for (const lang of EXPECTED_LANGS) {
      const v = L[lang][key];
      if (typeof v === 'string' && v.length >= 3 && !/^(FoodFlow|http)/.test(v)) {
        vals[lang] = v;
      }
    }
    const langList = Object.keys(vals);
    for (let i = 0; i < langList.length; i++) {
      for (let j = i + 1; j < langList.length; j++) {
        if (SAME_OK_VALUES.has(vals[langList[i]])) continue;
        if (vals[langList[i]] === vals[langList[j]]) {
          warnings.push(`跨语言雷同: [${langList[i]}.${key}] 与 [${langList[j]}.${key}] → "${vals[langList[i]].slice(0, 20)}"`);
        }
      }
    }
  }

  return { errors, warnings };
}

try {
  const L = loadLocales();
  const { errors, warnings } = check(L);

  console.log('🔎 语言包一致性检查' + (CHECK_DUP ? '（含跨语言雷同）' : '') + '\n');
  if (!CHECK_DUP) console.log('   提示：加 --check-dup 可查看跨语言雷同\n');

  if (errors.length) {
    console.log(`❌ 错误 (${errors.length}):`);
    errors.forEach(e => console.log('   ' + e));
  }
  if (warnings.length) {
    console.log(`⚠️  告警 (${warnings.length}):`);
    warnings.slice(0, 40).forEach(w => console.log('   ' + w));
    if (warnings.length > 40) console.log(`   ... 还有 ${warnings.length - 40} 条`);
  }
  if (!errors.length && !warnings.length) console.log('✅ 全部通过');

  console.log('\n📊 各语言 key 数量:');
  for (const lang of EXPECTED_LANGS) {
    const top = Object.keys(L[lang]).filter(k => k !== 'categories').length;
    const cats = Object.keys(L[lang].categories || {}).length;
    console.log(`   ${lang}: 顶层 ${top}, categories ${cats}`);
  }

  if (errors.length) process.exit(1);
  if (STRICT && warnings.length) process.exit(1);
} catch (e) {
  console.error('❌ 检查失败（硬错误）:', e.message);
  process.exit(1);
}
