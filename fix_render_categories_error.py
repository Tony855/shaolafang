with open('pages/customer.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 在renderCategories函数开头加默认空数组
old = '''        function renderCategories() {
            const presentCategories = [...new Set(state.menu.map(i => i.category).filter(Boolean))];'''

new = '''        function renderCategories() {
            state.menu = state.menu || [];
            state.categoryOrder = state.categoryOrder || [];
            const presentCategories = [...new Set(state.menu.map(i => i.category).filter(Boolean))];'''

if old in content:
    content = content.replace(old, new)
    print("修复renderCategories函数成功！")
else:
    print("没找到renderCategories函数")

with open('pages/customer.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
