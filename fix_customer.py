import re

with open('pages/customer.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# 找第一个位置：在第一个 if (info.customerToken) 块结束后插入
# 第308行是 }，第309行是 await fetchStoreInfo()
for i in range(len(lines)):
    if 'await fetchStoreInfo();' in lines[i] and i > 300 and i < 320:
        # 在这一行前面插入
        insert_lines = [
            '                    if (!state.customerToken) {\n',
            '                        state.customerToken = \'ct_\' + Date.now() + \'_\' + Math.random().toString(36).substr(2, 9);\n',
            '                        SLF.store.rawSet(\'customer_token\', state.customerToken);\n',
            '                    }\n'
        ]
        lines = lines[:i] + insert_lines + lines[i:]
        print(f"在第{i+1}行插入了第一个自动生成代码")
        break

# 找第二个位置：在第二个 if (session.customerToken) 块结束后，try { 前面插入
for i in range(len(lines)):
    if 'try {' in lines[i] and i > 320 and i < 340:
        insert_lines = [
            '                    if (!state.customerToken) {\n',
            '                        state.customerToken = \'ct_\' + Date.now() + \'_\' + Math.random().toString(36).substr(2, 9);\n',
            '                        SLF.store.rawSet(\'customer_token\', state.customerToken);\n',
            '                    }\n'
        ]
        lines = lines[:i] + insert_lines + lines[i:]
        print(f"在第{i+1}行插入了第二个自动生成代码")
        break

# 写回
with open('pages/customer.js', 'w', encoding='utf-8', newline='') as f:
    f.writelines(lines)

print("完成！")
