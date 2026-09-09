file_path = r"C:\Users\DONGFENG\Downloads\shaolafang\admin.html"

with open(file_path, 'r', encoding='utf-8-sig') as f:
    content = f.read()

# 1. Remove updateStatsSummary() function
old_func = """        function updateStatsSummary() {
            const done = ordersCache.filter(o => o.status === 'done');
            const now = new Date();
            const today = now.toDateString();
            const todayAmount = done.filter(o => new Date(o.createdAt).toDateString() === today).reduce((s, o) => s +
                Number(o.total || 0), 0);
            const monthKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
            const monthAmount = done.filter(o => {
                const d = new Date(o.createdAt);
                return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` === monthKey;
            }).reduce((s, o) => s + Number(o.total || 0), 0);
            $('#todayRevenue').textContent = formatMoney(todayAmount);
            $('#monthRevenue').textContent = formatMoney(monthAmount);
        }

"""
content = content.replace(old_func, "")

# 2. Remove updateStatsSummary() call in loadOrders()
content = content.replace("            updateOrderSummary();\n            updateStatsSummary();\n", "            updateOrderSummary();\n")

# 3. Remove todayRevenueLabel/monthRevenueLabel references in applyAdminLanguage
content = content.replace("            $('#todayRevenueLabel').textContent = tAdmin('todayRevenue');\n", "")
content = content.replace("            $('#monthRevenueLabel').textContent = tAdmin('monthRevenue');\n", "")

with open(file_path, 'w', encoding='utf-8-sig') as f:
    f.write(content)

print("Fixed runtime errors!")
print("Removed updateStatsSummary function and calls")
