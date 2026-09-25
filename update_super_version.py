with open('super.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 批量替换所有版本号
content = content.replace('v=20260923c', 'v=20260925a')
content = content.replace('v=20260923', 'v=20260925a')

print("更新super.html版本号成功！")

with open('super.html', 'w', encoding='utf-8', newline='') as f:
    f.write(content)
