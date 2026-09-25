import re

# 更新index.html里的版本号到v=20260925b
with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# 把所有?v=后面的版本号改成20260925b
content = re.sub(r'\?v=\w+', '?v=20260925b', content)
print("更新index.html版本号成功！")

with open('index.html', 'w', encoding='utf-8', newline='') as f:
    f.write(content)

# 更新admin.html里的版本号
with open('admin.html', 'r', encoding='utf-8') as f:
    content2 = f.read()
content2 = re.sub(r'\?v=\w+', '?v=20260925b', content2)
print("更新admin.html版本号成功！")
with open('admin.html', 'w', encoding='utf-8', newline='') as f:
    f.write(content2)

# 更新super.html里的版本号
with open('super.html', 'r', encoding='utf-8') as f:
    content3 = f.read()
content3 = re.sub(r'\?v=\w+', '?v=20260925b', content3)
print("更新super.html版本号成功！")
with open('super.html', 'w', encoding='utf-8', newline='') as f:
    f.write(content3)
