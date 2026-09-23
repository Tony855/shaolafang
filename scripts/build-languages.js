/**
 * ============================================================
 *  build-languages.js
 *
 *  用途：将 languages.js 压缩为 languages.min.js
 *  用法：node build-languages.js
 *        （或 npm run build:lang，会自动先跑 check-lang）
 *
 *  兼容：terser 5.x
 *
 *  依赖：
 *   npm install --save-dev terser
 *
 *  流程：
 *   0) 构建前调用 scripts/check-lang.js 校验语言包
 *   1) 读取 languages.js
 *   2) terser 压缩
 *   3) 结构验证（LANGUAGES / detectBrowserLanguage 是否保留）
 *   4) 构建后 diff 校验（min 与 source key 集合/抽查值一致）
 *   5) 输出提示
 * ============================================================
 */

const { minify } = require('terser');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

/* ------------------------------------------------------------
   工具：在 vm 沙箱中执行代码，提取 LANGUAGES / detectBrowserLanguage
   ------------------------------------------------------------ */
function extractFromCode(code) {
  const sandbox = { module: { exports: {} }, exports: {}, console };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const langs = sandbox.LANGUAGES || (sandbox.window && sandbox.window.LANGUAGES);
  const detect = sandbox.detectBrowserLanguage
    || (sandbox.window && sandbox.window.detectBrowserLanguage);
  return { langs, detect };
}

/* ------------------------------------------------------------
   阶段 0：构建前校验
   ------------------------------------------------------------ */
function preCheck(checkScriptPath) {
  if (!fs.existsSync(checkScriptPath)) {
    console.warn('⚠️  未找到 scripts/check-lang.js，跳过构建前校验');
    return;
  }
  console.log('🔎 构建前校验语言包...');
  try {
    execSync(`node "${checkScriptPath}"`, { stdio: 'inherit' });
    console.log('');
  } catch (e) {
    console.error('❌ 语言包校验未通过，终止构建');
    console.error('   提示：若只是告警不影响构建，可临时移除 build-languages.js 中的 preCheck 调用');
    process.exit(1);
  }
}

/* ------------------------------------------------------------
   主流程
   ------------------------------------------------------------ */
async function build() {
  // ---------- 0. 构建前校验 ----------
  preCheck(path.join(__dirname, 'scripts', 'check-lang.js'));

  const srcPath = path.join(__dirname, 'languages.js');
  const outPath = path.join(__dirname, 'languages.min.js');

  if (!fs.existsSync(srcPath)) {
    console.error('❌ 找不到 languages.js，请确认当前目录是否为项目根目录。');
    process.exit(1);
  }

  const code = fs.readFileSync(srcPath, 'utf8');
  const srcSize = Buffer.byteLength(code, 'utf8');

  console.log(`📖 读取 languages.js：${(srcSize / 1024).toFixed(1)} KB`);

  // ---------- 1. 压缩 ----------
  let result;
  try {
    result = await minify(code, {
      compress: {
        toplevel: false,
        keep_fnames: true,
        keep_classnames: true,
        drop_console: false,
        passes: 2,
        sequences: true,
        unused: true,
        conditionals: true,
        evaluate: true,
        dead_code: true,
      },
      mangle: {
        toplevel: false,
        keep_fnames: true,
      },
      format: {
        comments: false,
        ascii_only: false,
        max_line_len: 500,
      },
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

  // ---------- 2. 写入 languages.min.js ----------
  try {
    fs.writeFileSync(outPath, result.code, 'utf8');
  } catch (e) {
    console.error('❌ 写入 languages.min.js 失败:', e.message);
    process.exit(1);
  }

  const outSize = Buffer.byteLength(result.code, 'utf8');
  const ratio = ((1 - outSize / srcSize) * 100).toFixed(1);

  console.log('✅ languages.min.js 已生成');
  console.log(`   原始：${(srcSize / 1024).toFixed(1)} KB`);
  console.log(`   压缩：${(outSize / 1024).toFixed(1)} KB`);
  console.log(`   减少：${ratio}%`);
  console.log('');

  // ---------- 3. 结构验证（源文件） ----------
  let srcExtract;
  try {
    srcExtract = extractFromCode(code);
  } catch (e) {
    console.error('⚠️  源文件结构验证失败:', e.message);
    process.exit(1);
  }

  if (!srcExtract.langs || typeof srcExtract.langs !== 'object') {
    console.error('❌ languages.js 中未找到 LANGUAGES 对象');
    process.exit(1);
  }

  // ---------- 4. 结构验证（压缩产物） ----------
  let minExtract;
  try {
    minExtract = extractFromCode(result.code);
  } catch (e) {
    console.error('⚠️  压缩后无法通过 vm 沙箱提取 LANGUAGES，请检查 --no-toplevel 配置！');
    console.error('   详细错误:', e.message);
    process.exit(1);
  }

  if (!minExtract.langs || typeof minExtract.langs !== 'object') {
    console.error('❌ 压缩后 LANGUAGES 丢失，请检查 terser 的 mangle.toplevel 配置');
    process.exit(1);
  }

  // ---------- 5. 构建后 diff 校验：key 集合与抽查值 ----------
  const srcLangKeys = Object.keys(srcExtract.langs);
  const minLangKeys = Object.keys(minExtract.langs);

  const expectedLangs = ['zh', 'en', 'vi', 'th', 'km'];
  const missingLangs = expectedLangs.filter(k => !minLangKeys.includes(k));
  if (missingLangs.length > 0) {
    console.error(`❌ 压缩后缺少语言：${missingLangs.join(', ')}`);
    process.exit(1);
  }

  // 5.1 key 集合 diff（以 zh 为基准）
  const srcZhKeys = new Set(Object.keys(srcExtract.langs.zh));
  const minZhKeys = new Set(Object.keys(minExtract.langs.zh));
  const missingKeys = [...srcZhKeys].filter(k => !minZhKeys.has(k));
  const extraKeys = [...minZhKeys].filter(k => !srcZhKeys.has(k));

  if (missingKeys.length) {
    console.error(`❌ 压缩后 zh 缺失 ${missingKeys.length} 个 key：`);
    console.error(`   ${missingKeys.slice(0, 20).join(', ')}${missingKeys.length > 20 ? ' ...' : ''}`);
    process.exit(1);
  }
  if (extraKeys.length) {
    console.warn(`⚠️  压缩后 zh 多出 ${extraKeys.length} 个 key：`);
    console.warn(`   ${extraKeys.slice(0, 20).join(', ')}${extraKeys.length > 20 ? ' ...' : ''}`);
  }

  // 5.2 抽查高频 key 的值（避免压缩过程中被替换/丢失）
  const spotKeys = [
    'login', 'confirm', 'cancel', 'save', 'delete',
    'hourlyDistribution', 'callWaiter', 'total',
    'pending', 'done', 'canceled',
  ];
  const valueMismatch = [];
  for (const k of spotKeys) {
    const srcVal = srcExtract.langs.zh[k];
    const minVal = minExtract.langs.zh[k];
    if (srcVal !== minVal) {
      valueMismatch.push({ key: k, src: srcVal, min: minVal });
    }
  }
  if (valueMismatch.length) {
    console.error(`❌ 压缩后 ${valueMismatch.length} 个抽查 key 的值不一致：`);
    valueMismatch.forEach(m => {
      console.error(`   ${m.key}: src="${m.src}" min="${m.min}"`);
    });
    process.exit(1);
  }

  // 5.3 categories 子对象
  for (const lang of expectedLangs) {
    if (!minExtract.langs[lang]) continue;
    const srcCats = Object.keys(srcExtract.langs[lang].categories || {});
    const minCats = Object.keys(minExtract.langs[lang].categories || {});
    if (srcCats.length !== minCats.length) {
      console.error(`❌ [${lang}.categories] 数量不一致：src=${srcCats.length}, min=${minCats.length}`);
      process.exit(1);
    }
  }

  // 5.4 detectBrowserLanguage
  if (typeof srcExtract.detect === 'function' && typeof minExtract.detect !== 'function') {
    console.error('❌ 压缩后 detectBrowserLanguage 丢失');
    process.exit(1);
  }

  console.log('✅ 构建后校验通过：min 与 source 完全一致');
  console.log('');

  // ---------- 6. 结构统计 ----------
  console.log('🔎 结构验证：');
  for (const lang of minLangKeys) {
    const dict = minExtract.langs[lang];
    if (!dict || typeof dict !== 'object') {
      console.log(`   ${lang}: ⚠️ 无效`);
      continue;
    }
    const topCount = Object.keys(dict).length;
    const catCount = dict.categories ? Object.keys(dict.categories).length : 0;
    console.log(`   ${lang}: 顶层 ${topCount} 个 key，categories ${catCount} 个`);
  }
  console.log(`   detectBrowserLanguage: ${typeof minExtract.detect === 'function' ? '✅' : '❌ 缺失'}`);
  console.log('');

  // ---------- 7. 后续提示 ----------
  console.log('下一步：');
  console.log('  1. 打开前端页面，把 languages.min.js 的版本号更新为新的（如 ?v=20260923c）');
  console.log('     命令示例：');
  console.log("       sed -i 's|languages.min.js?v=20260923b|languages.min.js?v=20260923c|g' *.html");
  console.log('  2. 重启服务：sudo systemctl restart foodflow');
  console.log('  3. 浏览器硬刷新（Ctrl+Shift+R）验证切换语言');
}

/* ------------------------------------------------------------
   入口
   ------------------------------------------------------------ */
build().catch(e => {
  console.error('❌ 未捕获错误:', e);
  process.exit(1);
});