with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 更新所有静态资源版本号
content = content.replace('customer.css?v=20260924a', 'customer.css?v=20260925a')
content = content.replace('customer.js?v=20260923', 'customer.js?v=20260925a')
content = content.replace('core.js?v=20260923', 'core.js?v=20260925a')
content = content.replace('ui.js?v=20260923', 'ui.js?v=20260925a')
content = content.replace('money.js?v=20260923', 'money.js?v=20260925a')
content = content.replace('order-status.js?v=20260923', 'order-status.js?v=20260925a')
content = content.replace('customer-group.js?v=20260923', 'customer-group.js?v=20260925a')
content = content.replace('role.js?v=20260923', 'role.js?v=20260925a')
content = content.replace('idle.js?v=20260923', 'idle.js?v=20260925a')

with open('index.html', 'w', encoding='utf-8', newline='') as f:
    f.write(content)

print("版本号更新完成！")
