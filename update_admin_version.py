with open('admin.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 批量替换所有版本号
content = content.replace('v=20260914c', 'v=20260925a')
content = content.replace('v=20260921e', 'v=20260925a')
content = content.replace('v=20260924batch3', 'v=20260925a')
content = content.replace("v='20260924debug40'", "v=20260925a")

print("更新admin.html版本号成功！")

with open('admin.html', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
