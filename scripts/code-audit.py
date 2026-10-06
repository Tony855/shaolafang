#!/usr/bin/env python3
"""FoodFlow 代码审计：接口重复 + 函数重复"""
import re
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent

# ---------- Part 1: 后端路由 ----------
ROUTE_PAT = re.compile(r"app\.(get|post|put|delete|patch|all)\s*\(\s*['\"]([^'\"]+)['\"]")
route_defs = defaultdict(list)
for f in sorted((ROOT / 'routes').glob('*.js')):
    for i, line in enumerate(f.read_text(encoding='utf-8').splitlines(), 1):
        for m in ROUTE_PAT.finditer(line):
            route_defs[(m.group(1).upper(), m.group(2))].append((f.name, i))

print('=' * 70)
print('Part 1 · 路由重复（同 method + path）')
print('=' * 70)
dups = [(k, v) for k, v in route_defs.items() if len(v) > 1]
if dups:
    for (method, path), defs in dups:
        print(f'  ❌ {method:6s} {path}')
        for fname, line in defs:
            print(f'        {fname}:{line}')
else:
    print('  ✅ 无重复')
print(f'\n  总计：{len(route_defs)} 个不同接口\n')

# ---------- Part 2: 前端函数 ----------
FUNC_PATS = [
    re.compile(r'\bfunction\s+([a-zA-Z_$][\w$]*)\s*\('),
    re.compile(r'\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\()'),
]
skip_kw = {'if', 'for', 'while', 'switch', 'return', 'catch', 'then', 'else'}

def collect(dirs):
    defs = defaultdict(list)
    for d in dirs:
        if not d.exists(): continue
        for f in sorted(d.rglob('*.js')):
            if 'bundle' in f.name or 'languages.min' in f.name: continue
            for i, line in enumerate(f.read_text(encoding='utf-8').splitlines(), 1):
                s = line.lstrip()
                if s.startswith(('//', '*', '/*')): continue
                for pat in FUNC_PATS:
                    for m in pat.finditer(line):
                        name = m.group(1)
                        if len(name) < 3 or name in skip_kw: continue
                        defs[name].append((f.relative_to(ROOT).as_posix(), i))
    return defs

def report(name, defs):
    cross = {}
    for fn, lst in defs.items():
        if len(set(x[0] for x in lst)) > 1:
            cross[fn] = lst
    print('=' * 70)
    print(f'{name} · 跨文件重复函数')
    print('=' * 70)
    if not cross:
        print('  ✅ 无重复\n'); return
    for fn, lst in sorted(cross.items(), key=lambda x: -len(x[1])):
        print(f'  🔁 {fn}  ({len(lst)} 处)')
        for f, i in lst:
            print(f'        {f}:{i}')
    print()

report('Part 2', collect([ROOT / 'pages', ROOT / 'assets' / 'modules']))
report('Part 3', collect([ROOT / 'routes', ROOT / 'server']))
