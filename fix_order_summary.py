with open('pages/admin/shared.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 修复updateOrderSummary函数
old = '''function updateOrderSummary() {
  const orders = ctx.ordersCache();
  const pending = orders.filter(o => o.status === 'pending');
  const total = pending.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const el = $('#orderSummary');
  if (el) el.textContent = `${pending.length} ${tAdmin('pendingOrders') || '待处理'} · ${SLF.money.primary(total)}`;
}'''

new = '''function updateOrderSummary() {
  const orders = ctx.ordersCache();
  // 统计未结算订单
  const pending = orders.filter(o => o.status === 'pending');
  const pendingTotal = pending.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const pendingCountEl = document.getElementById('pendingOrderCount');
  const pendingAmountEl = document.getElementById('pendingOrderAmount');
  if (pendingCountEl) pendingCountEl.textContent = pending.length;
  if (pendingAmountEl) pendingAmountEl.textContent = SLF.money.primary(pendingTotal);
  // 统计已结算订单
  const done = orders.filter(o => o.status === 'done');
  const doneTotal = done.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const doneCountEl = document.getElementById('doneOrderCount');
  const doneAmountEl = document.getElementById('doneOrderAmount');
  if (doneCountEl) doneCountEl.textContent = done.length;
  if (doneAmountEl) doneAmountEl.textContent = SLF.money.primary(doneTotal);
}'''

if old in content:
    content = content.replace(old, new)
    print("修复updateOrderSummary函数成功！")
else:
    print("没找到要替换的内容")

with open('pages/admin/shared.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
