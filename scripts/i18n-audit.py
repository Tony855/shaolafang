#!/usr/bin/env python3
"""
FoodFlow i18n 全站审计
用法：python3 scripts/i18n-audit.py
输出：i18n-audit-YYYYMMDD-HHMMSS/ 目录下 4 个报告 + summary.txt
"""
import json, re, sys, time
from pathlib import Path

ROOT = Path('.').resolve()
LANGS = ['zh', 'en', 'vi', 'th', 'km']
CH_RE = re.compile(r'[\u4e00-\u9fff]')

EXCLUDE_DIRS = {'node_modules', '.git', 'uploads', 'backups', 'logs', 'vendor', 'dist'}
EXCLUDE_FILES = re.compile(r'(\.bak-|\.min\.js$|\.map$|package-lock\.json$|languages\.min\.js$)', re.I)

# ---------- 收集待扫描文件 ----------
def walk(exts):
    out = []
    for p in ROOT.rglob('*'):
        if not p.is_file(): continue
        if p.suffix.lower() not in exts: continue
        if EXCLUDE_FILES.search(p.name): continue
        parts = set(p.relative_to(ROOT).parts)
        if parts & EXCLUDE_DIRS: continue
        out.append(p)
    return out

# ---------- 报告 1：locales 对齐 ----------
def report_locales(outdir):
    files = {l: ROOT / 'locales' / f'{l}.json' for l in LANGS}
    dicts = {}
    for l, f in files.items():
        if not f.exists():
            dicts[l] = None; continue
        try:
            dicts[l] = json.loads(f.read_text(encoding='utf-8'))
        except Exception as e:
            dicts[l] = None
            print(f'⚠️  {l}.json 解析失败: {e}')

    zh = dicts.get('zh') or {}
    zh_keys = set(zh.keys())

    lines = ['lang\ttotal\tmissing_vs_zh\textra_vs_zh']
    missing_detail = {}
    for l in LANGS:
        d = dicts.get(l)
        if d is None:
            lines.append(f'{l}\tN/A'); continue
        ks = set(d.keys())
        miss = zh_keys - ks
        extra = ks - zh_keys
        lines.append(f'{l}\t{len(ks)}\t{len(miss)}\t{len(extra)}')
        if miss: missing_detail[l] = sorted(miss)

    (outdir / '01-locales.txt').write_text('\n'.join(lines), encoding='utf-8')
    for l, ks in missing_detail.items():
        (outdir / f'01-locales-{l}-missing.txt').write_text('\n'.join(ks), encoding='utf-8')

    return '\n'.join(lines)

# ---------- 报告 2：HTML 硬编码 ----------
# 找 >中文< 纯文本节点，且该 <...> 标签上没有 data-i18n*
def report_html(outdir):
    hits = []
    for p in walk({'.html'}):
        rel = p.relative_to(ROOT)
        for i, line in enumerate(p.read_text(encoding='utf-8').splitlines(), 1):
            s = line.strip()
            if not s or s.startswith('<!--') or s.startswith('//'): continue
            # >中文<  或  >中文（…）<  这种纯文本
            for m in re.finditer(r'>([^<>]*[\u4e00-\u9fff][^<>]*)<', line):
                txt = m.group(1).strip()
                if not txt: continue
                # 看当前标签行是否有 data-i18n
                tag_start = line.rfind('<', 0, m.start())
                tag_seg = line[tag_start:m.start()] if tag_start >= 0 else ''
                if 'data-i18n' in tag_seg: continue
                hits.append(f'{rel}:{i}\t{txt[:80]}')
    (outdir / '02-html-hardcoded.txt').write_text('\n'.join(hits), encoding='utf-8')
    return f'HTML 硬编码中文：{len(hits)} 处'

# ---------- 报告 3：JS 硬编码 ----------
# 找 '中文' / "中文" / `中文` 且同行前面 60 字符内没 t(/tAdmin(/L(/SLF.t(
T_WRAP = re.compile(r'(?:^|[^\w.])t\s*\(|tAdmin\s*\(|\bL\s*\(|SLF\.t\s*\(|i18n\.t\s*\(')
STR_RE = re.compile(r"(['\"`])((?:(?!\1).)*[\u4e00-\u9fff](?:(?!\1).)*)\1")

def report_js(outdir):
    hits = []
    skip_line = re.compile(r'(console\.(log|warn|error|debug)|^\s*//|^\s*\*)')
    for p in walk({'.js'}):
        rel = p.relative_to(ROOT)
        for i, line in enumerate(p.read_text(encoding='utf-8').splitlines(), 1):
            if skip_line.search(line): continue
            for m in STR_RE.finditer(line):
                content = m.group(2)
                pre = line[max(0, m.start() - 60):m.start()]
                if T_WRAP.search(pre): continue
                # 排除 URL、CSS 值、正则、注释尾部
                if re.search(r'https?://', line[max(0, m.start()-8):m.end()+8]): continue
                if re.search(r'^\s*(\*|//)', line): continue
                hits.append(f'{rel}:{i}\t{content[:80]}')
    (outdir / '03-js-hardcoded.txt').write_text('\n'.join(hits), encoding='utf-8')
    return f'JS 硬编码中文：{len(hits)} 处'

# ---------- 报告 4：后端 routes 硬编码（JSON error 里中文） ----------
def report_routes(outdir):
    hits = []
    pat = re.compile(r'(?:error|message)\s*:\s*([\'"`])((?:(?!\1).)*[\u4e00-\u9fff](?:(?!\1).)*)\1')
    for p in walk({'.js'}):
        rel = p.relative_to(ROOT)
        if 'routes' not in rel.parts and 'server' not in rel.parts: continue
        for i, line in enumerate(p.read_text(encoding='utf-8').splitlines(), 1):
            for m in pat.finditer(line):
                hits.append(f'{rel}:{i}\t{m.group(2)[:100]}')
    (outdir / '04-routes-errors.txt').write_text('\n'.join(hits), encoding='utf-8')
    return f'后端硬编码错误：{len(hits)} 处'

# ---------- 主流程 ----------
def main():
    ts = time.strftime('%Y%m%d-%H%M%S')
    outdir = ROOT / f'i18n-audit-{ts}'
    outdir.mkdir(exist_ok=True)

    print(f'📂 输出目录：{outdir}\n')
    print('=' * 60)
    print('报告 1 · locales 对齐')
    print('=' * 60)
    print(report_locales(outdir))
    print()
    print('=' * 60)
    print('报告 2 · HTML 硬编码')
    print('=' * 60)
    print(report_html(outdir))
    print()
    print('=' * 60)
    print('报告 3 · JS 硬编码')
    print('=' * 60)
    print(report_js(outdir))
    print()
    print('=' * 60)
    print('报告 4 · 后端 routes error')
    print('=' * 60)
    print(report_routes(outdir))
    print()
    print('✅ 全部完成。明细文件：')
    for f in sorted(outdir.glob('*.txt')):
        print(f'   {f.relative_to(ROOT)}')

if __name__ == '__main__':
    main()
