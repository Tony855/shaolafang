import re

with open('pages/customer.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# 找state初始化结束的位置（第106行是 };）
for i in range(len(lines)):
    if '};' in lines[i] and i > 100 and i < 110:
        # 在这一行后面插入自动生成代码
        insert_lines = [
            '\n',
            '        // 页面初始化时自动生成唯一customer_token\n',
            '        if (!SLF.store.rawGet(\'customer_token\')) {\n',
            '            state.customerToken = \'ct_\' + Date.now() + \'_\' + Math.random().toString(36).substr(2, 9);\n',
            '            SLF.store.rawSet(\'customer_token\', state.customerToken);\n',
            '        } else {\n',
            '            state.customerToken = SLF.store.rawGet(\'customer_token\');\n',
            '        }\n'
        ]
        lines = lines[:i+1] + insert_lines + lines[i+1:]
        print(f"在第{i+1}行插入了全局自动生成代码")
        break

# 写回
with open('pages/customer.js', 'w', encoding='utf-8', newline='') as f:
    f.writelines(lines)

print("完成！")
