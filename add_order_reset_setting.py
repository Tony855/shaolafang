with open('admin.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 在订单前缀的form-grid下面加重置周期下拉框
old = '''                    <div class="settings-form-grid">
                        <div class="form-group"><label id="prefixNormalLabel">普通消费前缀</label><input id="prefixNormal" maxlength="2" style="width:80px;height:42px;padding:0 12px;font-size:14px;border-radius:10px;border:1px solid #4d4d70;background:#22223a;color:#fff;outline:none;"></div>
                        <div class="form-group"><label id="prefixRefundLabel">退款单前缀</label><input id="prefixRefund" maxlength="2" style="width:80px;height:42px;padding:0 12px;font-size:14px;border-radius:10px;border:1px solid #4d4d70;background:#22223a;color:#fff;outline:none;"></div>
                        <div class="form-group"><label id="prefixDiscountLabel">打折消费前缀</label><input id="prefixDiscount" maxlength="2" style="width:80px;height:42px;padding:0 12px;font-size:14px;border-radius:10px;border:1px solid #4d4d70;background:#22223a;color:#fff;outline:none;"></div>
                        <div class="form-group"><label id="prefixVipLabel">VIP消费前缀</label><input id="prefixVip" maxlength="2" style="width:80px;height:42px;padding:0 12px;font-size:14px;border-radius:10px;border:1px solid #4d4d70;background:#22223a;color:#fff;outline:none;"></div>
                    </div>'''

new = '''                    <div class="settings-form-grid">
                        <div class="form-group"><label id="prefixNormalLabel">普通消费前缀</label><input id="prefixNormal" maxlength="2" style="width:80px;height:42px;padding:0 12px;font-size:14px;border-radius:10px;border:1px solid #4d4d70;background:#22223a;color:#fff;outline:none;"></div>
                        <div class="form-group"><label id="prefixRefundLabel">退款单前缀</label><input id="prefixRefund" maxlength="2" style="width:80px;height:42px;padding:0 12px;font-size:14px;border-radius:10px;border:1px solid #4d4d70;background:#22223a;color:#fff;outline:none;"></div>
                        <div class="form-group"><label id="prefixDiscountLabel">打折消费前缀</label><input id="prefixDiscount" maxlength="2" style="width:80px;height:42px;padding:0 12px;font-size:14px;border-radius:10px;border:1px solid #4d4d70;background:#22223a;color:#fff;outline:none;"></div>
                        <div class="form-group"><label id="prefixVipLabel">VIP消费前缀</label><input id="prefixVip" maxlength="2" style="width:80px;height:42px;padding:0 12px;font-size:14px;border-radius:10px;border:1px solid #4d4d70;background:#22223a;color:#fff;outline:none;"></div>
                        <div class="form-group"><label id="orderResetPeriodLabel">订单号重置周期</label>
                            <select id="orderResetPeriod" style="width:100%;height:42px;padding:0 12px;font-size:14px;border-radius:10px;border:1px solid #4d4d70;background:#22223a;color:#fff;outline:none;">
                                <option value="daily">每天重置（从00001开始）</option>
                                <option value="monthly">每月重置（从00001开始）</option>
                                <option value="yearly">每年重置（从00001开始）</option>
                                <option value="never">从不重置（全局累加）</option>
                            </select>
                        </div>
                    </div>'''

if old in content:
    content = content.replace(old, new)
    print("加加重置周期下拉框成功！")
else:
    print("没找到订单前缀设置部分")

with open('admin.html', 'w', encoding='utf-8', newline='') as f:
    f.write(content)

# 修改settings.js里的加载和保存函数
with open('pages/admin/settings.js', 'r', encoding='utf-8') as f:
    content2 = f.read()

# 修改loadOrderPrefixes
old_load = '''async function loadOrderPrefixes() {
  try {
    const d = await SLF.api.get('/admin/order-prefixes');
    $('#prefixNormal').value = d.order_prefix_normal || '11';
    $('#prefixRefund').value = d.order_prefix_refund || '01';
    $('#prefixDiscount').value = d.order_prefix_discount || '21';
    $('#prefixVip').value = d.order_prefix_vip || '61';
  } catch (e) {}
}'''

new_load = '''async function loadOrderPrefixes() {
  try {
    const d = await SLF.api.get('/admin/order-prefixes');
    $('#prefixNormal').value = d.order_prefix_normal || '11';
    $('#prefixRefund').value = d.order_prefix_refund || '01';
    $('#prefixDiscount').value = d.order_prefix_discount || '21';
    $('#prefixVip').value = d.order_prefix_vip || '61';
    $('#orderResetPeriod').value = d.order_no_reset_period || 'daily';
  } catch (e) {}
}'''

if old_load in content2:
    content2 = content2.replace(old_load, new_load)
    print("修改加载函数成功！")
else:
    print("没找到加载函数")

# 修改saveOrderPrefixes
old_save = '''async function saveOrderPrefixes() {
  try {
    await SLF.api.post('/admin/order-prefixes', {
      normal: $('#prefixNormal').value,
      refund: $('#prefixRefund').value,
      discount: $('#prefixDiscount').value,
      vip: $('#prefixVip').value,
      daily_reset: 'daily'
    });
    SLF.ui.toast(L('saveSuccess') || '保存成功');
  } catch (e) {
    SLF.ui.toast(L('operationFailed') || '保存失败');
  }
}'''

new_save = '''async function saveOrderPrefixes() {
  try {
    await SLF.api.post('/admin/order-prefixes', {
      normal: $('#prefixNormal').value,
      refund: $('#prefixRefund').value,
      discount: $('#prefixDiscount').value,
      vip: $('#prefixVip').value,
      daily_reset: $('#orderResetPeriod').value
    });
    SLF.ui.toast(L('saveSuccess') || '保存成功');
  } catch (e) {
    SLF.ui.toast(L('operationFailed') || '保存失败');
  }
}'''

if old_save in content2:
    content2 = content2.replace(old_save, new_save)
    print("修改保存函数成功！")
else:
    print("没找到保存函数")

with open('pages/admin/settings.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content2)
