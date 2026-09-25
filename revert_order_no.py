with open('server/services/orderNo.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 改回原来的5位数字
old = "  return todayPrefix + String(next).padStart(2, '0');"
new = "  return todayPrefix + String(next).padStart(5, '0');"

if old in content:
    content = content.replace(old, new)
    print("恢复订单号格式成功！改回5位数字！")
else:
    print("没找到要修改的内容")

with open('server/services/orderNo.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
