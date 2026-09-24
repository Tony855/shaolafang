with open('routes/public-session.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 修改查询条件，去掉table_name过滤
old = '''      if (customerToken) {
        rows = await allAsync("SELECT * FROM orders WHERE table_name=? AND store_id=? AND customer_token=? AND status!='canceled' ORDER BY createdAt DESC", [session.table_name, session.store_id || 1, customerToken]);
      } else {'''

new = '''      if (customerToken) {
        // 只按customer_token + store_id查询，不管订单在哪个桌，都能查到自己的订单
        rows = await allAsync("SELECT * FROM orders WHERE store_id=? AND customer_token=? AND status!='canceled' ORDER BY createdAt DESC", [session.store_id || 1, customerToken]);
      } else {'''

if old in content:
    content = content.replace(old, new)
    print("修改成功！")
else:
    print("没找到要替换的内容")

with open('routes/public-session.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
