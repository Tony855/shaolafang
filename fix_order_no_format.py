with open('server/services/orderNo.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 把订单号后面的数字从5位改成2位，每天从01开始
old = "  return todayPrefix + String(next).padStart(5, '0');"
new = "  return todayPrefix + String(next).padStart(2, '0');"

if old in content:
    content = content.replace(old, new)
    print("修改订单号格式成功！每天从01开始！")
else:
    print("没找到要修改的内容")

with open('server/services/orderNo.js', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
