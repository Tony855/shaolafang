with open('routes/public-session.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 加时间限制：只查最近7天的订单
old = '''        // 只按customer_token + store_id查询，不管订单在哪个桌，都能查到自己的订单
        rows = await allAsync("SELECT * FROM orders WHERE store_id=? AND customer_token=? AND status!='canceled' ORDER BY createdAt DESC", [session.store_id || 1, customerToken]);'''

new = '''        // 只按customer_token + store_id查询，不管订单在哪个桌，都能查到自己的订单
        // 限定最近7天，避免无限累积历史订单
        const sevenDaysAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString();
        rows = await allAsync("SELECT * FROM orders WHERE store_id=? AND customer_token=? AND status!='canceled' AND createdAt > ? ORDER BY createdAt DESC", [session.store_id || 1, customerToken, sevenDaysAgo]);'''

if old in content:
    content = content.replace(old, new)
    print("加时间限制成功！")
else:
    print("没找到要替换的内容")

with open('routes/public-session.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
