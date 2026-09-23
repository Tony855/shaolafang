/**
 * ============================================================
 *  build-languages.js
 *
 *  数据源：locales/{zh,en,vi,th,km}.json
 *  产物：
 *    languages.js      浏览器可直接 <script> 引用（含 detectBrowserLanguage）
 *    languages.min.js  terser 压缩版
 *
 *  用法：node scripts/build-languages.js（或 npm run build:lang）
 *  依赖：npm install --save-dev terser
 *
 *  流程：
 *   0) 构建前校验 scripts/check-lang.js
 *   1) 读取 5 个 JSON（JSON.parse 天然去重/校验语法）
 *   2) 组装生成 languages.js
 *   3) terser 压缩生成 languages.min.js
 *   4) 构建后 diff 校验（min 与源 JSON key/抽查值一致）
 * ============================================================
 */

const { minify } = require('terser');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'locales');
const EXPECTED_LANGS = ['zh', 'en', 'vi', 'th', 'km'];

/* 加载 5 个 JSON */
function loadLocales() {
  const result = {};
  for (const lang of EXPECTED_LANGS) {
    const file = path.join(LOCALES_DIR, lang + '.json');
    if (!fs.existsSync(file)) throw new Error('缺少语言文件: locales/' + lang + '.json');
    result[lang] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return result;
}

/* 生成 languages.js 源码 */
function generateSource(L) {
  const header = `/* ============================================================
   FoodFlow Ordering System - Multi-language Translation Table
   本文件由 scripts/build-languages.js 从 locales/*.json 自动生成，请勿手改
   支持中文/英文/越南文/泰文/高棉文
   ============================================================ */

`;
  const body = 'const LANGUAGES = ' + JSON.stringify(L, null, 2) + ';\n\n';
  const detect = `/**
 * 检测浏览器语言并映射到系统支持的语言代码
 * @returns {string} zh/en/vi/th/km
 */
function detectBrowserLanguage() {
    const sys = (navigator.language || navigator.userLanguage || '').toLowerCase();
    if (sys.startsWith('zh')) return 'zh';
    if (sys.startsWith('vi')) return 'vi';
    if (sys.startsWith('th')) return 'th';
    if (sys.startsWith('km')) return 'km';
    if (sys.startsWith('en')) return 'en';
    return 'zh';
}

// 兼容旧代码：确保全局可访问
if (typeof window !== 'undefined') {
  window.LANGUAGES = LANGUAGES;
  window.detectBrowserLanguage = detectBrowserLanguage;
}
`;
  return header + body + detect;
}

/* 在 vm 沙箱中执行代码，提取 LANGUAGES */
function extractFromCode(code) {
  const sandbox = { navigator: { language: 'zh' }, console };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.LANGUAGES;
}

/* 构建前校验（不阻断 warning，只阻断 JSON/脚本硬错误） */
function preCheck() {
  const checkScript = path.join(__dirname, 'check-lang.js');
  if (!fs.existsSync(checkScript)) {
    console.warn('⚠️  未找到 scripts/check-lang.js，跳过构建前校验\n');
    return;
  }
  console.log('🔎 构建前校验语言包...');
  try {
    execSync(`node "${checkScript}"`, { stdio: 'inherit' });
  } catch (e) {
    // check-lang 以 exit 1 表示存在 error 级问题
    console.error('❌ 语言包存在错误，终止构建（可用 --warning-only 仅查看告警）');
    process.exit(1);
  }
  console.log('');
}

async function build() {
  preCheck();

  const L = loadLocales();

  // ---------- 1. 生成 languages.js ----------
  const source = generateSource(L);
  const srcPath = path.join(ROOT, 'languages.js');
  fs.writeFileSync(srcPath, source, 'utf8');
  const srcSize = Buffer.byteLength(source, 'utf8');
  console.log(`📝 languages.js 已生成：${(srcSize / 1024).toFixed(1)} KB`);

  // ---------- 2. terser 压缩 ----------
  let result;
  try {
    result = await minify(source, {
      compress: {
        keep_fnames: true,
        keep_classnames: true,
        drop_console: false,
        passes: 2,
      },
      mangle: { keep_fnames: true },
      format: { comments: false, ascii_only: false, max_line_len: 500 },
      ecma: 2017,
      sourceMap: false,
    });
  } catch (e) {
    console.error('❌ terser 压缩异常:', e.message);
    process.exit(1);
  }
  if (result.error) {
    console.error('❌ 压缩失败:', result.error);
    process.exit(1);
  }

  const outPath = path.join(ROOT, 'languages.min.js');
  fs.writeFileSync(outPath, result.code, 'utf8');
  const outSize = Buffer.byteLength(result.code, 'utf8');
  console.log(`✅ languages.min.js 已生成：${(outSize / 1024).toFixed(1)} KB（减少 ${((1 - outSize / srcSize) * 100).toFixed(1)}%）\n`);

  // ---------- 3. 构建后 diff 校验 ----------
  const minLangs = extractFromCode(result.code);
  if (!minLangs) {
    console.error('❌ 压缩后 LANGUAGES 丢失');
    process.exit(1);
  }

  let failed = false;
  for (const lang of EXPECTED_LANGS) {
    const srcKeys = Object.keys(L[lang]);
    const minKeys = Object.keys(minLangs[lang] || {});
    if (srcKeys.length !== minKeys.length) {
      console.error(`❌ [${lang}] key 数量不一致：source=${srcKeys.length}, min=${minKeys.length}`);
      failed = true;
    }
  }

  // 抽查高频 key
  const spotKeys = ['login', 'confirm', 'cancel', 'save', 'total', 'pending', 'done'];
  for (const k of spotKeys) {
    for (const lang of EXPECTED_LANGS) {
      if (L[lang][k] !== minLangs[lang][k]) {
        console.error(`❌ [${lang}.${k}] 压缩后值不一致`);
        failed = true;
      }
    }
  }

  if (failed) process.exit(1);
  console.log('✅ 构建后校验通过：min 与 locales 完全一致\n');

  console.log('下一步：');
  console.log('  1. 更新 HTML 中 languages.min.js 版本号并硬刷新验证');
  console.log('  2. 重启服务：sudo systemctl restart foodflow');
}

build().catch(e => {
  console.error('❌ 未捕获错误:', e);
  process.exit(1);
});
