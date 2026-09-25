with open('pages/admin/order.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 把orderTableFilter改成全局变量
content = content.replace('let orderTableFilter = \'\';', 'window.orderTableFilter = window.orderTableFilter || \'\';')
content = content.replace('orderTableFilter = q;', 'window.orderTableFilter = q;')
content = content.replace('if (orderTableFilter) {', 'if (window.orderTableFilter) {')
content = content.replace('const q = orderTableFilter.toLowerCase();', 'const q = window.orderTableFilter.toLowerCase();')

print("修复orderTableFilter变量作用域成功！")

with open('pages/admin/order.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content)

# 修复admin.js里的filterOrders函数
with open('pages/admin.js', 'r', encoding='utf-8') as f:
    content2 = f.read()

old_filter = '''        function filterOrders() {
            orderTableFilter = $('#orderTableSearch').value.trim();
            window.loadOrders();
        }'''

new_filter = '''        function filterOrders() {
            window.orderTableFilter = $('#orderTableSearch').value.trim();
            window.loadOrders();
        }'''

if old_filter in content2:
    content2 = content2.replace(old_filter, new_filter)
    print("修复admin.js里的filterOrders函数成功！")
else:
    print("没找到admin.js里的filterOrders函数")

with open('pages/admin.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content2)
