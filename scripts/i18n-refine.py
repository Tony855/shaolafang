#!/usr/bin/env python3
"""从初版审计结果里提炼真问题"""
import re, time
from pathlib import Path

ROOT = Path('.').resolve()
outdir_root = sorted([d for d in ROOT.glob('i18n-audit-*')], reverse=True)
if not outdir_root:
    print('❌ 先跑 i18n-audit.py'); raise SystemExit(1)
src = outdir_root[0]
out = ROOT / f'i18n-refined-{time.strftime("%Y%m%d-%H%M%S")}'
out.mkdir()

# -------- HTML：只保留 title / placeholder / aria-label / 纯文本 --------
html_in = (src / '02-html-hardcoded.txt').read_text(encoding='utf-8').splitlines()
html_keep = []
for line in html_in:
    if not line.strip(): continue
    file, _, txt = line.partition('\t')
    # 过滤品牌名 / 纯符号 / 数据属性
    t = txt.strip()
    if t in ('味享', 'FoodFlow', '食物流'): continue
    if re.fullmatch(r'[\W_]+', t): continue
    html_keep.append(line)
(out / 'html-real.txt').write_text('\n'.join(html_keep), encoding='utf-8')

# -------- JS：只保留 toast/alert/confirm/innerHTML/textContent 里的中文 --------
js_in = (src / '03-js-hardcoded.txt').read_text(encoding='utf-8').splitlines()
js_keep = []
USER_FACING = re.compile(
    r'SLF\.ui\.toast\s*\(|\.toast\s*\(|alert\s*\(|confirm\s*\(|'
    r'\.innerHTML\s*=|\.textContent\s*=|\.placeholder\s*=|\.title\s*=|'
    r'showConfirm\s*\(|showError\s*\(|setText\s*\(|setPlaceholder\s*\('
)
for line in js_in:
    if not line.strip(): continue
    file, _, txt = line.partition('\t')
    path = ROOT / file.split(':')[0]
    if not path.exists(): continue
    lineno = int(file.split(':')[1])
    all_lines = path.read_text(encoding='utf-8').splitlines()
    ctx = all_lines[lineno - 1] if 0 < lineno <= len(all_lines) else ''
    if not USER_FACING.search(ctx): continue
    js_keep.append(line)
(out / 'js-real.txt').write_text('\n'.join(js_keep), encoding='utf-8')

# -------- routes：全部保留，但按前缀归类 --------
routes_in = (src / '04-routes-errors.txt').read_text(encoding='utf-8').splitlines()
(out / 'routes-all.txt').write_text('\n'.join(routes_in), encoding='utf-8')

print(f'原始   HTML={len(html_in)}  JS={len(js_in)}  routes={len(routes_in)}')
print(f'精炼后 HTML={len(html_keep)}  JS={len(js_keep)}  routes={len(routes_in)}')
print(f'\n📂 输出目录：{out.relative_to(ROOT)}')
print(f'   html-real.txt     HTML 真问题')
print(f'   js-real.txt       JS 真问题（用户可见）')
print(f'   routes-all.txt    后端错误全量（一般不需要改）')
