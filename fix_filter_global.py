with open('pages/admin.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 把filterOrders挂载到window
old = '''        function filterOrders() {
            window.orderTableFilter = $('#orderTableSearch').value.trim();
            window.loadOrders();
        }'''

new = '''        window.filterOrders = function() {
            window.orderTableFilter = $('#orderTableSearch').value.trim();
            if (window.loadOrders) window.loadOrders();
        }'''

if old in content:
    content = content.replace(old, new)
    print("修复filterOrders挂载到window成功！")
else:
    print("没找到filterOrders函数")

with open('pages/admin.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content)

# 修复order.js里的loadOrders挂载到window
with open('pages/admin/order.js', 'r', encoding='utf-8') as f:
    content2 = f.read()

# 在loadOrders函数后面加挂载到window
old2 = '''  if (typeof updateOrderSummary === 'function') updateOrderSummary();
  if (ctx.tablesCache().length && window.loadTables) window.loadTables();
}'''

new2 = '''  if (typeof updateOrderSummary === 'function') updateOrderSummary();
  if (ctx.tablesCache().length && window.loadTables) window.loadTables();
}
window.loadOrders = loadOrders;'''

if old2 in content2:
    content2 = content2.replace(old2, new2)
    print("修复loadOrders挂载到window成功！")
else:
    print("没找到loadOrders函数结尾")

with open('pages/admin/order.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content2)
