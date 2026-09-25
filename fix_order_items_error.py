with open('pages/customer.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 在order处理的时候，给items加默认空数组，防止报错
old = '''                data.orders.forEach((order) => {
                    let timeStr = '未知时间';'''

new = '''                data.orders.forEach((order) => {
                    order.items = order.items || [];
                    let timeStr = '未知时间';'''

if old in content:
    content = content.replace(old, new)
    print("修复订单items为空报错成功！")
else:
    print("没找到要修改的内容")

with open('pages/customer.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
