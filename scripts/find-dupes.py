#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FoodFlow 函数重复检查工具
用法: python3 scripts/find-dupes.py [--min-lines N] [--min-ratio R]
"""
import re, pathlib, hashlib, sys
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent

MIN_LINES = 5
MIN_RATIO = 0.85
args = sys.argv[1:]
i = 0
while i < len(args):
    if args[i] == '--min-lines' and i + 1 < len(args):
        MIN_LINES = int(args[i+1]); i += 2
    elif args[i] == '--min-ratio' and i + 1 < len(args):
        MIN_RATIO = float(args[i+1]); i += 2
    else:
        i += 1

class C:
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    BLUE='\033[0;34m'; GRAY='\033[0;90m'; NC='\033[0m'

def title(t):
    print(); print(f"{C.BLUE}{'═'*78}{C.NC}")
    print(f"{C.BLUE}  {t}{C.NC}")
    print(f"{C.BLUE}{'═'*78}{C.NC}")

js_files = [f for f in ROOT.rglob('*.js')
            if 'node_modules' not in str(f)
            and not f.name.endswith('.min.js')
            and 'admin-bundle.js' not in str(f)]
print(f"扫描 {len(js_files)} 个 JS 文件")

def extract_funcs(text, rel):
    funcs = []
    lines = text.split('\n')
    pats = [
        re.compile(r'^\s*(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\('),
        re.compile(r'^\s*(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\()'),
    ]
    i = 0
    while i < len(lines):
        line = lines[i]
        m = None
        for p in pats:
            m = p.match(line)
            if m: break
        if not m:
            i += 1; continue
        name = m.group(1)
        if name in ('if','for','while','switch','catch','function','return') or len(name) < 3:
            i += 1; continue
        brace = line.find('{')
        if brace < 0: i += 1; continue
        depth = 0
        j = i
        start_col = brace
        end_line = None
        while j < len(lines):
            row = lines[j]
            sc = start_col if j == i else 0
            for k in range(sc, len(row)):
                if row[k] == '{': depth += 1
                elif row[k] == '}':
                    depth -= 1
                    if depth == 0:
                        end_line = j + 1
                        break
            if end_line is not None: break
            j += 1
        if end_line is None: i += 1; continue
        body = '\n'.join(lines[i:end_line])
        body_norm = re.sub(r'//[^\n]*', '', body)
        body_norm = re.sub(r'/\*.*?\*/', '', body_norm, flags=re.DOTALL)
        body_clean = re.sub(r'\s+', ' ', body_norm).strip()
        funcs.append({
            'name': name, 'file': rel,
            'line_start': i+1, 'line_end': end_line,
            'lines': end_line - i,
            'body_norm': body_clean,
            'tokens': set(re.findall(r'[a-zA-Z_$][\w$]*|\d+', body_clean)),
            'hash': hashlib.md5(body_clean.encode()).hexdigest(),
        })
        i = end_line
    return funcs

all_funcs = []
for jp in js_files:
    try:
        text = jp.read_text(encoding='utf-8')
    except: continue
    all_funcs.extend(extract_funcs(text, str(jp.relative_to(ROOT))))

print(f"共提取 {len(all_funcs)} 个函数")

# 【1】同名
title("【1】同名函数")
by_name = defaultdict(list)
for f in all_funcs: by_name[f['name']].append(f)
dupes = {k:v for k,v in by_name.items() if len(v) > 1}
if dupes:
    print(f"  {C.YELLOW}找到 {len(dupes)} 个同名函数{C.NC}\n")
    for name, locs in sorted(dupes.items(), key=lambda x: -len(x[1])):
        print(f"  {C.RED}⚠️  {name}{C.NC}  ({len(locs)} 处)")
        for f in locs:
            print(f"       {C.GRAY}{f['file']}:{f['line_start']} ({f['lines']}行){C.NC}")
else:
    print(f"  {C.GREEN}✅ 无同名{C.NC}")

# 【2】完全相同
title("【2】完全相同的函数体")
by_hash = defaultdict(list)
for f in all_funcs:
    if f['lines'] >= 3: by_hash[f['hash']].append(f)
dupes2 = {k:v for k,v in by_hash.items() if len(v) > 1}
if dupes2:
    print(f"  {C.RED}找到 {len(dupes2)} 组完全相同{C.NC}\n")
    for h, funcs in sorted(dupes2.items(), key=lambda x: -len(x[1]))[:20]:
        print(f"  {C.RED}⚠️  {len(funcs)} 个完全相同（{funcs[0]['lines']} 行）{C.NC}")
        for f in funcs:
            print(f"       {C.GRAY}[{f['name']}] {f['file']}:{f['line_start']}{C.NC}")
        print()
else:
    print(f"  {C.GREEN}✅ 无完全相同{C.NC}")

# 【3】相似
title(f"【3】相似函数（Jaccard ≥ {MIN_RATIO}，仅 ≥ {MIN_LINES} 行）")
candidates = [f for f in all_funcs if f['lines'] >= MIN_LINES]
print(f"  (对 {len(candidates)} 个函数做对比)\n")

by_prefix = defaultdict(list)
for f in candidates:
    prefix = re.match(r'^([a-zA-Z]+)', f['name'])
    if prefix: by_prefix[prefix.group(1).lower()].append(f)

similar = []
for prefix, funcs in by_prefix.items():
    if len(funcs) < 2 or len(funcs) > 50: continue
    for i in range(len(funcs)):
        for j in range(i+1, len(funcs)):
            a, b = funcs[i], funcs[j]
            if a['hash'] == b['hash']: continue
            inter = len(a['tokens'] & b['tokens'])
            union = len(a['tokens'] | b['tokens'])
            if union == 0: continue
            ratio = inter / union
            if ratio >= MIN_RATIO:
                similar.append((ratio, a, b))

if similar:
    similar.sort(key=lambda x: -x[0])
    seen = set()
    print(f"  {C.YELLOW}找到 {len(similar)} 组相似{C.NC}\n")
    count = 0
    for ratio, a, b in similar:
        k = tuple(sorted([a['hash'], b['hash']]))
        if k in seen: continue
        seen.add(k)
        print(f"  {C.YELLOW}相似度 {ratio*100:.0f}%{C.NC}")
        print(f"       A: [{a['name']}] {a['file']}:{a['line_start']} ({a['lines']}行)")
        print(f"       B: [{b['name']}] {b['file']}:{b['line_start']} ({b['lines']}行)\n")
        count += 1
        if count >= 30: break
else:
    print(f"  {C.GREEN}✅ 无相似函数{C.NC}")

# 【4】统计
title("【4】文件函数统计 TOP 30")
by_file = defaultdict(int)
for f in all_funcs: by_file[f['file']] += 1
for file, count in sorted(by_file.items(), key=lambda x: -x[1])[:30]:
    print(f"  {C.GRAY}{count:>4}  {file}{C.NC}")

print()
print(f"{C.BLUE}{'═'*78}{C.NC}")
