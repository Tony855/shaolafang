with open('pages/waiter.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 在服务员端订单块里加桌号标签
old = '''      return `<div class="order-block"><div class="order-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><span>${o.order_no || ("#"+o.id)} · ${t('orderPending', null, '未结算')}${badge}<span class="order-meta"> · ${timeLabel}</span></span>${orderSettleBtn}</div>${noteHtml}<div class="bill-items">${lines}</div></div>`;'''

new = '''      return `<div class="order-block"><div class="order-head" style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><span>${o.order_no || ("#"+o.id)} · <span style="padding:2px 6px;border-radius:4px;background:#e3f2fd;color:#1976d2;font-size:12px;">🏷️ ${esc(o.table || '-')}</span> · ${t('orderPending', null, '未结算')}${badge}<span class="order-meta"> · ${timeLabel}</span></span>${orderSettleBtn}</div>${noteHtml}<div class="bill-items">${lines}</div></div>`;'''

if old in content:
    content = content.replace(old, new)
    print("服务员端加桌号标签成功！")
else:
    print("没找到要替换的内容")

with open('pages/waiter.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
