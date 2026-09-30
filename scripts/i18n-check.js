const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'locales');
const BASE = process.env.I18N_BASE || 'en';
const LANGS = ['zh', 'vi', 'th', 'km'];

const base = JSON.parse(fs.readFileSync(path.join(DIR, BASE + '.json'), 'utf8'));
const baseTop = Object.entries(base).filter(([k]) => k !== 'categories');
const baseCats = Object.entries(base.categories || {});

console.log(`基准: ${BASE} (顶层 ${baseTop.length} + 分类 ${baseCats.length})\n`);

for (const lang of LANGS) {
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(DIR, lang + '.json'), 'utf8')); }
  catch (e) { console.log(`❌ ${lang}.json 解析失败: ${e.message}`); continue; }

  const missTop = baseTop.map(([k]) => k).filter(k => !(k in data));
  const missCats = baseCats.map(([k]) => k).filter(k => !(k in (data.categories || {})));
  const extraTop = Object.keys(data).filter(k => k !== 'categories' && !(k in base));

  // km 特有：检测乱码
  let corrupted = 0;
  if (lang === 'km') {
    for (const [k, v] of Object.entries(data)) {
      if (typeof v !== 'string') continue;
      const nonKhmer = [...v].filter(c => {
        const code = c.codePointAt(0);
        return code > 0x7F && !(code >= 0x1780 && code <= 0x17FF);
      });
      if (nonKhmer.length > v.length * 0.3) corrupted++;
    }
  }

  console.log(`${lang}.json:`);
  console.log(`  顶层缺 ${missTop.length}, 分类缺 ${missCats.length}, 多余 ${extraTop.length}${lang === 'km' ? `, 乱码 ${corrupted}` : ''}`);
  if (missTop.length && missTop.length <= 20) console.log(`    缺: ${missTop.join(', ')}`);
  if (missCats.length) console.log(`    分类缺: ${missCats.join(', ')}`);
  console.log('');
}
