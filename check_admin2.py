#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""检查 admin.html 中剩余的硬编码中文，按模块分类"""

import re

with open('admin.html', 'r', encoding='utf-8-sig') as f:
    content = f.read()

lines = content.split('\n')

# 定义模块范围（根据函数名和注释）
modules = [
    ('订单管理', 2540, 2720),
    ('菜品管理', 2560, 2620),
    ('桌号管理', 2620, 2660),
    ('货币管理', 2680, 2710),
    ('登录日志', 2700, 2720),
    ('服务员管理', 2720, 2760),
    ('店铺管理', 2760, 2800),
    ('打印机管理', 4280, 4340),
    ('营业报表', 4440, 4530),
    ('预约管理', 4340, 4440),
    ('呼叫服务员', 4240, 4280),
]

print("=== admin.html 剩余硬编码中文（按模块）===\n")

for module_name, start, end in modules:
    found = []
    for i in range(start, min(end, len(lines))):
        line = lines[i]
        # 检查 JS 字符串中的中文
        js_strings = re.findall(r"'([^']*[\u4e00-\u9fa5][^']*)'", line)
        for text in js_strings:
            if len(text) < 60 and not text.startswith('http'):
                found.append((i+1, text))
        
        # 检查模板字符串中的中文
        template_strings = re.findall(r'`([^`]*[\u4e00-\u9fa5][^`]*)`', line)
        for text in template_strings:
            # 提取中文部分
            chinese_parts = re.findall(r'[\u4e00-\u9fa5]+', text)
            for part in chinese_parts:
                found.append((i+1, part))
    
    if found:
        unique = list(set([text for _, text in found]))
        print(f"\n【{module_name}】({len(unique)} 个唯一文本)")
        for line_num, text in found[:10]:
            print(f"  行{line_num}: {text[:50]}")
        if len(found) > 10:
            print(f"  ... 还有 {len(found)-10} 处")
