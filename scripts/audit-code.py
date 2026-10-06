#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FoodFlow 代码审计 v2
用法：python3 scripts/audit-code.py [--verbose]
"""
import re, sys, pathlib, subprocess
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent
VERBOSE = '--verbose' in sys.argv

class C:
    RED = '\033[0;31m'; GREEN = '\033[0;32m'; YELLOW = '\033[1;33m'
    BLUE = '\033[0;34m'; GRAY = '\033[0;90m'; NC = '\033[0m'

def color(t, c): return f"{c}{t}{C.NC}"
def title(t):
    print(); print(color("═"*60, C.BLUE)); print(color(f"  {t}", C.BLUE)); print(color("═"*60, C.BLUE))
def ok(t):   print(f"  {color('✅', C.GREEN)} {t}")
def warn(t): print(f"  {color('⚠️', C.YELLOW)}  {t}")
def err(t):  print(f"  {color('❌', C.RED)} {t}")
def info(t): print(f"  {color('ℹ️', C.GRAY)}  {t}")

BUILTIN = {
    'if','for','while','return','typeof','this','event','alert','confirm','prompt',
    'console','parseInt','parseFloat','Number','String','Math','Boolean','Array','Object','JSON',
    'setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame',
    'isNaN','isFinite','decodeURI','encodeURI','decodeURIComponent','encodeURIComponent',
    'remove','removeChild','appendChild','insertBefore','createElement',
    'getElementById','querySelector','querySelectorAll','addEventListener','removeEventListener',
    'toString','valueOf','getAttribute','setAttribute','removeAttribute',
    'scrollIntoView','focus','blur','click','submit','reset','preventDefault','stopPropagation',
    'open','close','print','reload','replace','push','pop','shift','unshift','splice','slice',
    'map','filter','reduce','forEach','find','findIndex','some','every','then','catch','finally',
    'call','apply','bind','parentNode','childNodes','children','firstChild','lastChild',
    'nextSibling','previousSibling','item','length','trim','split','join','indexOf','includes',
    'startsWith','endsWith','match','test',
}

PAGES = ['admin.html','cashier.html','index.html','kitchen.html',
         'login.html','super.html','waiter.html','menu-display.html']

def read_file(path):
    try: return pathlib.Path(path).read_text(encoding='utf-8')
    except: return ''

def extract_inline_handlers(html):
    handlers = set()
    pat = re.compile(
        r'''on(?:click|change|submit|input|keydown|keypress|keyup|blur|focus|load|error|'''
        r'''mouseover|mouseout|mouseenter|mouseleave|mousedown|mouseup|touchstart|touchend|touchmove)'''
        r'''\s*=\s*["']([^"']+)["']'''
    )
    for m in pat.finditer(html):
        for fm in re.finditer(r'\b([a-zA-Z_$][\w$]*)\s*\(', m.group(1)):
            if fm.group(1) not in BUILTIN:
                handlers.add(fm.group(1))
    return handlers

def extract_window_exports(js):
    out = set()
    for m in re.finditer(r'window\.([a-zA-Z_$][\w$]*)\s*=', js): out.add(m.group(1))
    for m in re.finditer(r'''window\[['"]([a-zA-Z_$][\w$]*)['"]\]\s*=''', js): out.add(m.group(1))
    return out

def extract_defined_functions(js):
    out = set()
    for m in re.finditer(r'\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(', js): out.add(m.group(1))
    for m in re.finditer(r'\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\()', js): out.add(m.group(1))
    return out

def resolve_script(html_path, src):
    p = src.split('?')[0].split('#')[0]
    if p.startswith('http') or p.startswith('//'): return None
    if p.startswith('/'): return ROOT / p.lstrip('/')
    p1 = html_path.parent / p
    if p1.exists(): return p1
    p2 = ROOT / p
    if p2.exists(): return p2
    return None

# ============ 1. JS 语法 ============
def syntax_check():
    title("【1】JS 语法检查")
    files = [f for f in ROOT.rglob('*.js') if 'node_modules' not in str(f) and not f.name.endswith('.min.js')]
    bad = []
    for f in files:
        r = subprocess.run(['node','--check',str(f)], capture_output=True, text=True)
        if r.returncode != 0:
            first = (r.stderr or '').strip().split('\n')[0]
            bad.append((f, first))
    if bad:
        for f, e in bad:
            err(f"{f.relative_to(ROOT)}")
            print(f"       {color(e, C.GRAY)}")
        return False
    ok(f"全部通过 ({len(files)} 个文件)")
    return True

# ============ 2. 内联事件对账 ============
def frontend_handler_audit():
    title("【2】HTML 内联事件 → JS 函数对账")
    ok_all = True
    for page in PAGES:
        hp = ROOT / page
        if not hp.exists(): continue
        html = read_file(hp)
        scripts = re.findall(r'<script[^>]+src=["\']([^"\']+\.js[^"\']*)["\']', html)
        handlers = extract_inline_handlers(html)
        exports, defined = set(), set()
        for s in scripts:
            jp = resolve_script(hp, s)
            if jp and jp.exists() and jp.suffix == '.js':
                js = read_file(jp)
                exports |= extract_window_exports(js)
                defined |= extract_defined_functions(js)
        if page == 'admin.html':
            for extra in ['assets/admin-bundle.js', 'pages/admin.js']:
                p = ROOT / extra
                if p.exists():
                    js = read_file(p)
                    exports |= extract_window_exports(js)
                    defined |= extract_defined_functions(js)
        missing = sorted(handlers - exports - defined)
        if missing:
            ok_all = False
            warn(f"{page}: {len(missing)} 个未找到定义")
            for fn in missing: print(f"       {color(fn+'()', C.GRAY)}")
        else:
            ok(f"{page}: 对齐")
    return ok_all

# ============ 3. HTML id 对账 ============
def html_id_audit():
    title("【3】JS 引用 id → HTML 定义对账")
    dynamic_ids = set()
    for jp in ROOT.rglob('*.js'):
        if 'node_modules' in str(jp): continue
        js = read_file(jp)
        for m in re.finditer(r"""\.id\s*=\s*['"]([a-zA-Z][\w-]*)['"]""", js): dynamic_ids.add(m.group(1))
        for m in re.finditer(r"""setAttribute\(\s*['"]id['"]\s*,\s*['"]([a-zA-Z][\w-]*)['"]""", js): dynamic_ids.add(m.group(1))
    pat = re.compile(r"""\$\(['"]#([\w\-]+)['"]\)|document\.getElementById\(['"]([\w\-]+)['"]\)""")
    ok_all = True
    for page in PAGES:
        hp = ROOT / page
        if not hp.exists(): continue
        html = read_file(hp)
        ids = set(re.findall(r'\bid=["\']([^"\']+)["\']', html))
        scripts = re.findall(r'<script[^>]+src=["\']([^"\']+\.js[^"\']*)["\']', html)
        hits = defaultdict(list)
        for s in scripts:
            jp = resolve_script(hp, s)
            if not jp or not jp.exists() or jp.suffix != '.js': continue
            js = read_file(jp)
            for lineno, line in enumerate(js.split('\n'), 1):
                for m in pat.finditer(line):
                    eid = m.group(1) or m.group(2)
                    if eid and eid not in ids and eid not in dynamic_ids:
                        hits[eid].append((str(jp.relative_to(ROOT)), lineno))
        if hits:
            ok_all = False
            warn(f"{page}: {len(hits)} 个 id 未定义")
            for eid, locs in sorted(hits.items()):
                print(f"       {color('#'+eid, C.GRAY)}  ({len(locs)} 处)")
                for f, ln in locs[:2]: print(f"           {color(f+':'+str(ln), C.GRAY)}")
        else:
            ok(f"{page}: 干净")
    return ok_all

# ============ 4. 后端引用 ============
def backend_audit():
    title("【4】后端模块引用检查")
    ok_all = True
    server_js = read_file(ROOT / 'server.js')
    required = set(re.findall(r"require\(['\"]\./routes/([\w\-]+)\.js['\"]\)", server_js))
    route_files = {f.stem for f in (ROOT / 'routes').glob('*.js')} if (ROOT / 'routes').exists() else set()
    unused = route_files - required
    missing = required - route_files
    print(f"  routes/: {len(route_files)} 个文件，server.js 引用 {len(required)} 个")
    if missing:
        ok_all = False
        err("require 指向的文件不存在：")
        for r in sorted(missing): print(f"       routes/{r}.js")
    if unused:
        warn("未被 server.js 引用的路由：")
        for r in sorted(unused): print(f"       routes/{r}.js")
    if not missing and not unused: ok("routes 全部已注册")

    all_js = '\n'.join(read_file(f) for f in ROOT.rglob('*.js') if 'node_modules' not in str(f))
    for sub in ['services','middleware','db','config']:
        d = ROOT / 'server' / sub
        if not d.exists(): continue
        files = {f.stem for f in d.glob('*.js')}
        unused_sub = []
        for name in files:
            pattern = rf"""require\(['"][^'"]*{re.escape(name)}['"]\)"""
            if not re.search(pattern, all_js):
                unused_sub.append(name)
        if unused_sub:
            warn(f"server/{sub}/ 未被 require：")
            for n in sorted(unused_sub): print(f"       server/{sub}/{n}.js")
        else:
            ok(f"server/{sub}/ 全部被引用 ({len(files)} 个)")
    return ok_all

# ============ 5. i18n ============
def i18n_audit():
    title("【5】i18n key 检查")
    zh_path = ROOT / 'locales' / 'zh.json'
    if not zh_path.exists():
        warn("locales/zh.json 不存在"); return True
    try:
        import json
        zh = json.loads(read_file(zh_path))
    except Exception as e:
        err(f"zh.json 解析失败: {e}"); return False

    def walk(o):
        for k, v in o.items():
            if isinstance(v, dict):
                # 嵌套对象本身也算一个 key（如 auditAction）
                yield k
                yield from walk(v)
            else:
                yield k
    all_keys = set(walk(zh))

    used_keys = set()
    sources = list(ROOT.glob('*.html')) + list(ROOT.glob('pages/**/*.js')) + \
              list(ROOT.glob('assets/**/*.js'))
    for src in sources:
        text = read_file(src)
        for m in re.finditer(r'data-i18n(?:-placeholder|-title)?=["\']([a-zA-Z0-9_]+)["\']', text):
            used_keys.add(m.group(1))
        for m in re.finditer(r"""(?:\bt|L|tAdmin|SLF\.t|SLF\.i18n\.t)\(\s*['"]([a-zA-Z0-9_]+)['"]""", text):
            used_keys.add(m.group(1))
        # 动态 key 前缀识别：'__err__' + xxx 或 'xxx' + yyy
        for m in re.finditer(r"""['"]([a-zA-Z0-9_]+)['"]\s*\+""", text):
            # 记录为"可能动态拼接的前缀"
            pass

    # 识别动态前缀（手工登记常见模式）
    dynamic_prefixes = set()
    core = read_file(ROOT / 'assets' / 'core.js')
    if "'__err__'" in core or '"__err__"' in core:
        dynamic_prefixes.add('__err__')

    unused = all_keys - used_keys
    truly_unused = set()
    dynamic_unused = set()
    for k in unused:
        is_dyn = False
        for prefix in dynamic_prefixes:
            if k.startswith(prefix):
                is_dyn = True; break
        if is_dyn: dynamic_unused.add(k)
        else: truly_unused.add(k)

    print(f"  zh.json: {len(all_keys)} key，静态引用: {len(used_keys)} key")
    info(f"动态前缀: {', '.join(sorted(dynamic_prefixes)) or '无'}")
    info(f"动态拼接未使用: {len(dynamic_unused)} 个（误报）")
    if not truly_unused:
        ok("静态未使用: 0 个")
    else:
        warn(f"静态未使用: {len(truly_unused)} 个")
        if VERBOSE:
            for k in sorted(truly_unused)[:50]: print(f"       {color(k, C.GRAY)}")
            if len(truly_unused) > 50: print(f"       {color(f'... 还有 {len(truly_unused)-50} 个', C.GRAY)}")
    return True

# ============ 6. CSS ============
def css_class_audit():
    title("【6】CSS class 检查")
    css_files = list((ROOT / 'assets').glob('*.css'))
    if not css_files:
        info("assets/ 下无 CSS"); return True

    defined = set()
    for css in css_files:
        for m in re.finditer(r'\.([a-zA-Z][\w-]+)', read_file(css)):
            defined.add(m.group(1))

    used = set()
    # HTML class="xxx"
    for html in ROOT.glob('*.html'):
        for m in re.finditer(r'class=["\']([^"\']+)["\']', read_file(html)):
            for cls in m.group(1).split(): used.add(cls)

    # JS 里所有可能引用 class 的地方
    prefixes = set()
    for jp in list(ROOT.glob('pages/**/*.js')) + list(ROOT.glob('assets/**/*.js')):
        text = read_file(jp)
        # classList.add('xxx')
        for m in re.finditer(r"classList\.(?:add|remove|toggle)\(\s*['\"]([a-zA-Z][\w-]*)['\"]", text):
            used.add(m.group(1))
        # className = 'xxx'
        for m in re.finditer(r"className\s*=\s*['\"]([a-zA-Z][\w-]*)['\"]", text):
            used.add(m.group(1))
        # ★ HTML 字符串里的 class="xxx yyy"（模板拼接和字符串拼接都覆盖）
        for m in re.finditer(r'''class=["']([^"']+)["']''', text):
            raw = m.group(1)
            # 拆空格，跳过含 ${ 的
            for cls in raw.split():
                if '${' not in cls: used.add(cls)
        # 拼接前缀：'xxx-' + var
        for m in re.finditer(r"""['"]([a-zA-Z][\w-]*-)['"]\s*\+""", text):
            prefixes.add(m.group(1))
        # 模板字符串 class="xxx-${...}"
        for m in re.finditer(r'''class=["']([a-zA-Z][\w-]*-\$\{)''', text):
            prefixes.add(m.group(1))

    unused = defined - used
    truly_unused = set()
    for cls in unused:
        is_dyn = any(cls.startswith(p) for p in prefixes)
        if not is_dyn: truly_unused.add(cls)

    print(f"  CSS 定义: {len(defined)}")
    print(f"  HTML/JS 引用: {len(used)}")
    info(f"拼接前缀: {len(prefixes)}")
    if not truly_unused:
        ok("无未使用 class")
    else:
        warn(f"疑似未使用: {len(truly_unused)}")
        if VERBOSE:
            for cls in sorted(truly_unused)[:50]: print(f"       {color('.'+cls, C.GRAY)}")
            if len(truly_unused) > 50: print(f"       {color(f'... 还有 {len(truly_unused)-50} 个', C.GRAY)}")
    return True

# ============ 7. window 导出 ============
def window_export_audit():
    title("【7】window.xxx 导出 → 使用检查")
    exports = {}
    for jp in list(ROOT.glob('pages/**/*.js')) + list(ROOT.glob('assets/**/*.js')):
        if 'node_modules' in str(jp): continue
        for fn in extract_window_exports(read_file(jp)):
            exports.setdefault(fn, []).append(str(jp.relative_to(ROOT)))

    all_html = '\n'.join(read_file(f) for f in ROOT.glob('*.html'))
    all_js = '\n'.join(read_file(f) for f in ROOT.rglob('*.js')
                       if 'node_modules' not in str(f) and not f.name.endswith('.min.js'))

    suspects = []
    for fn, defs in exports.items():
        fn_re = re.escape(fn)
        # HTML 内联事件 onclick="fn(...)"
        in_html = bool(re.search(rf'''on\w+\s*=\s*["'][^"']*\b{fn_re}\s*\(''', all_html))
        # HTML 任意位置 fn( 出现
        in_html_any = bool(re.search(rf'\b{fn_re}\s*\(', all_html))
        # JS 里 window.fn（>1 表示除了赋值外还有引用）
        in_js_window = len(re.findall(rf'window\.{fn_re}\b', all_js)) > 1
        # JS 里直接 fn( 调用（>1 表示除了定义外还有调用）
        in_js_direct = len(re.findall(rf'\b{fn_re}\s*\(', all_js)) > 1

        if not (in_html or in_html_any or in_js_window or in_js_direct):
            suspects.append((fn, defs[0]))

    if not suspects:
        ok(f"所有 {len(exports)} 个导出都有使用")
    else:
        warn(f"{len(suspects)} 个疑似未使用")
        if VERBOSE:
            for fn, f in suspects: print(f"       {color('window.'+fn, C.GRAY)}  ({f})")
        else:
            print(f"       {color('加 --verbose 看详情', C.GRAY)}")
    return True

# ============ 8. API 对账 ============
def api_audit():
    title("【8】API 前后端对账")

    frontend_apis = set()
    for jp in list(ROOT.glob('pages/**/*.js')) + list(ROOT.glob('assets/**/*.js')):
        text = read_file(jp)
        for m in re.finditer(r"""(?:api|SLF\.api\.(?:get|post|put|del|patch|request|page)|fetch)\(\s*['"`](/[^'"`?]+)""", text):
            path = m.group(1).rstrip('/')
            frontend_apis.add(path)

    backend_routes = set()
    for jp in (ROOT / 'routes').glob('*.js'):
        for m in re.finditer(r"""app\.(?:get|post|put|delete|patch)\(\s*['"`](/[^'"`]+)""", read_file(jp)):
            backend_routes.add(m.group(1))

    print(f"  前端调用: {len(frontend_apis)} 个")
    print(f"  后端定义: {len(backend_routes)} 个")

    def match(front, back):
        # 把后端的 :xxx 和 (\d+) 变成通配
        norm = re.sub(r'\(\\d\+\)', '§W§', back)
        norm = re.sub(r':[a-zA-Z_]\w*', '§W§', norm)
        norm = re.sub(r'\([^)]+\)', '§W§', norm)
        pat = re.escape(norm).replace('§W§', r'[^/]+')
        try:
            return re.search(pat + r'/?$', front) is not None
        except re.error:
            return front == back

    missing = []
    for front in sorted(frontend_apis):
        # 前端可能不带 /api，补上再试
        candidates = [front]
        if not front.startswith('/api/'):
            candidates.append('/api' + front)
        found = False
        for cand in candidates:
            for back in backend_routes:
                if match(cand, back):
                    found = True; break
            if found: break
        if not found:
            missing.append(front)

    if not missing:
        ok("所有前端 API 调用都能在后端找到")
    else:
        warn(f"{len(missing)} 个前端 API 调用未在后端找到")
        if VERBOSE:
            for p in missing[:40]: print(f"       {color(p, C.GRAY)}")
    return True

# ============ 主 ============
if __name__ == '__main__':
    print()
    print(color("═"*60, C.BLUE))
    print(color("  FoodFlow 代码审计 v2", C.BLUE))
    print(color("═"*60, C.BLUE))

    ok_all = True
    ok_all &= syntax_check()
    ok_all &= frontend_handler_audit()
    ok_all &= html_id_audit()
    ok_all &= backend_audit()
    i18n_audit()
    css_class_audit()
    window_export_audit()
    api_audit()

    print()
    print(color("═"*60, C.BLUE))
    if ok_all: print(color("  ✅ 全部关键检查通过", C.GREEN))
    else: print(color("  ⚠️  有告警", C.YELLOW))
    print(color("═"*60, C.BLUE))
    print()
    print(f"  提示：{color('python3 scripts/audit-code.py --verbose', C.GRAY)} 看详情")
    print()
    sys.exit(0 if ok_all else 1)
