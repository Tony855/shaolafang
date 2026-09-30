#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FoodFlow 全项目代码审计
用法：python3 scripts/audit-code.py
"""
import re, sys, pathlib, subprocess
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent

# 内联事件里常见的 JS/DOM 内建方法，不算"未定义"
BUILTIN = {
    'if','for','while','return','typeof','this','event','alert','confirm','prompt',
    'console','parseInt','parseFloat','Number','String','Math','Boolean','Array','Object','JSON',
    'setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame',
    'isNaN','isFinite','decodeURI','encodeURI','decodeURIComponent','encodeURIComponent',
    'remove','removeChild','appendChild','insertBefore','createElement',
    'getElementById','querySelector','querySelectorAll','addEventListener','removeEventListener',
    'toString','valueOf','getAttribute','setAttribute','removeAttribute',
    'scrollIntoView','focus','blur','click','submit','reset','preventDefault','stopPropagation',
    'open','close','print','reload','replace',
    'push','pop','shift','unshift','splice','slice','map','filter','reduce','forEach',
    'find','findIndex','some','every','then','catch','finally','call','apply','bind',
    'parentNode','childNodes','children','firstChild','lastChild','nextSibling','previousSibling',
    'item','length','trim','split','join','indexOf','includes','startsWith','endsWith','match','test',
}

def extract_inline_handlers(html):
    handlers = set()
    pat = re.compile(
        r'''on(?:click|change|submit|input|keydown|keypress|keyup|blur|focus|load|error|'''
        r'''mouseover|mouseout|mouseenter|mouseleave|mousedown|mouseup|touchstart|touchend|touchmove)'''
        r'''\s*=\s*["']([^"']+)["']'''
    )
    for m in pat.finditer(html):
        body = m.group(1)
        for fm in re.finditer(r'\b([a-zA-Z_$][\w$]*)\s*\(', body):
            fn = fm.group(1)
            if fn not in BUILTIN:
                handlers.add(fn)
    return handlers

def extract_window_exports(js):
    exports = set()
    for m in re.finditer(r'window\.([a-zA-Z_$][\w$]*)\s*=', js):
        exports.add(m.group(1))
    for m in re.finditer(r'''window\[['"]([a-zA-Z_$][\w$]*)['"]\]\s*=''', js):
        exports.add(m.group(1))
    return exports

def extract_defined_functions(js):
    defined = set()
    for m in re.finditer(r'\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(', js):
        defined.add(m.group(1))
    for m in re.finditer(r'\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\()', js):
        defined.add(m.group(1))
    return defined

def resolve_script(html_path, src):
    """把 <script src="xxx?v=1"> 解析为磁盘路径"""
    path = src.split('?')[0].split('#')[0]
    if path.startswith('http') or path.startswith('//'):
        return None
    if path.startswith('/'):
        return ROOT / path.lstrip('/')
    # 先相对 html 目录，再相对项目根
    p1 = html_path.parent / path
    if p1.exists():
        return p1
    p2 = ROOT / path
    if p2.exists():
        return p2
    return None

PAGES = ['admin.html','cashier.html','index.html','kitchen.html',
         'login.html','super.html','waiter.html']

def syntax_check():
    print("=" * 64)
    print("【1】JS 语法检查")
    print("=" * 64)
    files = [f for f in ROOT.rglob('*.js')
             if 'node_modules' not in str(f) and not f.name.endswith('.min.js')]
    bad = []
    for f in files:
        r = subprocess.run(['node','--check',str(f)], capture_output=True, text=True)
        if r.returncode != 0:
            first = (r.stderr or '').strip().split('\n')[0]
            bad.append((f, first))
    if bad:
        for f, err in bad:
            print(f"  ❌ {f.relative_to(ROOT)}")
            print(f"       {err}")
        print(f"\n  共 {len(bad)}/{len(files)} 个文件语法错误")
        return False
    print(f"  ✅ 全部通过 ({len(files)} 个文件)")
    return True

def frontend_handler_audit():
    print()
    print("=" * 64)
    print("【2】HTML 内联事件 → JS 函数对账")
    print("=" * 64)
    ok = True
    for page in PAGES:
        hp = ROOT / page
        if not hp.exists(): continue
        html = hp.read_text(encoding='utf-8')
        scripts = re.findall(r'<script[^>]+src=["\']([^"\']+\.js[^"\']*)["\']', html)
        handlers = extract_inline_handlers(html)
        all_exports, all_defined = set(), set()
        for s in scripts:
            jp = resolve_script(hp, s)
            if jp and jp.exists() and jp.suffix == '.js':
                try:
                    js = jp.read_text(encoding='utf-8')
                    all_exports |= extract_window_exports(js)
                    all_defined |= extract_defined_functions(js)
                except: pass
        missing = sorted(handlers - all_exports - all_defined)
        if missing:
            ok = False
            print(f"  ⚠️  {page}: {len(missing)} 个内联调用未找到函数定义")
            for fn in missing:
                print(f"       {fn}()")
        else:
            print(f"  ✅ {page}: 对齐")
    return ok

def html_id_audit():
    print()
    print("=" * 64)
    print("【3】JS 里 getElementById / $('#id') → HTML id 对账")
    print("=" * 64)
    pat = re.compile(
        r"""\$\(['"]#([\w\-]+)['"]\)|document\.getElementById\(['"]([\w\-]+)['"]\)"""
    )
    ok = True
    for page in PAGES:
        hp = ROOT / page
        if not hp.exists(): continue
        html = hp.read_text(encoding='utf-8')
        ids = set(re.findall(r'\bid=["\']([^"\']+)["\']', html))
        scripts = re.findall(r'<script[^>]+src=["\']([^"\']+\.js[^"\']*)["\']', html)
        hits = defaultdict(list)
        for s in scripts:
            jp = resolve_script(hp, s)
            if not jp or not jp.exists() or jp.suffix != '.js': continue
            js = jp.read_text(encoding='utf-8')
            for lineno, line in enumerate(js.split('\n'), 1):
                for m in pat.finditer(line):
                    eid = m.group(1) or m.group(2)
                    if eid and eid not in ids:
                        hits[eid].append((str(jp.relative_to(ROOT)), lineno))
        if hits:
            ok = False
            print(f"  ⚠️  {page}: {len(hits)} 个 id 被 JS 引用但 HTML 里不存在")
            for eid, locs in sorted(hits.items()):
                print(f"       #{eid}  ({len(locs)} 处引用)")
                for f, ln in locs[:2]:
                    print(f"           {f}:{ln}")
        else:
            print(f"  ✅ {page}: 干净")
    return ok

def backend_audit():
    print()
    print("=" * 64)
    print("【4】后端 routes / services / middleware 引用完整性")
    print("=" * 64)
    ok = True
    server_js = (ROOT / 'server.js').read_text(encoding='utf-8') if (ROOT / 'server.js').exists() else ''
    
    required = set(re.findall(r"require\(['\"]\./routes/([\w\-]+)\.js['\"]\)", server_js))
    route_files = {f.stem for f in (ROOT / 'routes').glob('*.js')} if (ROOT / 'routes').exists() else set()
    unused = route_files - required
    missing = required - route_files
    print(f"  routes/: {len(route_files)} 个文件，server.js 引用 {len(required)} 个")
    if missing:
        ok = False
        print(f"  ❌ require 指向的文件不存在：")
        for r in sorted(missing): print(f"       routes/{r}.js")
    if unused:
        print(f"  ⚠️  未被 server.js 引用的路由（可能是新加但没挂）：")
        for r in sorted(unused): print(f"       routes/{r}.js")
    if not missing and not unused:
        print("  ✅ routes 全部已注册")
    
    all_js_text = '\n'.join(
        f.read_text(encoding='utf-8') for f in ROOT.rglob('*.js')
        if 'node_modules' not in str(f)
    )
    for sub in ['services', 'middleware']:
        d = ROOT / 'server' / sub
        if not d.exists(): continue
        files = {f.stem for f in d.glob('*.js')}
        unused_sub = []
        for name in files:
            if not re.search(rf"""require\(['"][^'"]*{sub}/{name}['"]\)""", all_js_text):
                unused_sub.append(name)
        if unused_sub:
            print(f"  ⚠️  server/{sub}/ 未被 require 的文件：")
            for n in sorted(unused_sub): print(f"       server/{sub}/{n}.js")
        else:
            print(f"  ✅ server/{sub}/ 全部被引用 ({len(files)} 个)")
    return ok

def dead_code_audit():
    print()
    print("=" * 64)
    print("【5】前端 window.xxx 导出但从未被引用（软死码）")
    print("=" * 64)
    # 汇总所有 HTML 内联调用
    all_calls = set()
    all_html = ''
    for page in PAGES:
        hp = ROOT / page
        if not hp.exists(): continue
        txt = hp.read_text(encoding='utf-8')
        all_html += txt
        all_calls |= extract_inline_handlers(txt)
    all_js_text = '\n'.join(
        f.read_text(encoding='utf-8') for f in ROOT.rglob('*.js')
        if 'node_modules' not in str(f) and not f.name.endswith('.min.js')
    )
    suspects = []
    for jp in ROOT.rglob('*.js'):
        if 'node_modules' in str(jp) or jp.name.endswith('.min.js'): continue
        if '/assets/' in str(jp): continue
        try: js = jp.read_text(encoding='utf-8')
        except: continue
        for exp in extract_window_exports(js):
            if exp in all_calls: continue
            if exp in all_html: continue
            # 在 JS 里被调用次数（定义处 + 调用处）
            cnt = len(re.findall(rf'\b{re.escape(exp)}\s*\(', all_js_text))
            if cnt <= 1:
                suspects.append((str(jp.relative_to(ROOT)), exp))
    if suspects:
        print(f"  ℹ️  {len(suspects)} 个 window 导出疑似未被调用（供参考，可能确实需要）")
        # 按文件分组
        grouped = defaultdict(list)
        for f, fn in suspects: grouped[f].append(fn)
        for f in sorted(grouped):
            print(f"    {f}:")
            for fn in sorted(grouped[f]):
                print(f"        window.{fn}")
    else:
        print("  ✅ 无软死码")
    return True

if __name__ == '__main__':
    ok = True
    ok &= syntax_check()
    ok &= frontend_handler_audit()
    ok &= html_id_audit()
    ok &= backend_audit()
    ok &= dead_code_audit()
    print()
    print("=" * 64)
    print("✅ 全部通过" if ok else "⚠️  有告警，见上方详情")
    print("=" * 64)
    sys.exit(0 if ok else 1)
