with open('pages/customer.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 在订单header里加桌号标签
old = '''                                <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:1;">
                                    <span class="order-id">
                                        <span class="order-id-hash">#</span>${esc(order.order_no || ("#" + order.id))}
                                    </span>
                                    <span style="font-size:12px;color:#888;white-space:nowrap;">🕒 ${esc(timeStr)}</span>
                                </div>'''

new = '''                                <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;flex:1;">
                                    <span class="order-id">
                                        <span class="order-id-hash">#</span>${esc(order.order_no || ("#" + order.id))}
                                    </span>
                                    ${order.table_name ? `<span style="font-size:12px;padding:2px 6px;border-radius:4px;background:${order.table_name===state.tableName?'#e8f5e9':'#f5f5f5'};color:${order.table_name===state.tableName?'#2e7d32':'#666'};">🏷️ ${esc(order.table_name)}</span>` : ''}
                                    <span style="font-size:12px;color:#888;white-space:nowrap;">🕒 ${esc(timeStr)}</span>
                                </div>'''

if old in content:
    content = content.replace(old, new)
    print("加桌号标签成功！")
else:
    print("没找到要替换的内容")

with open('pages/customer.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
