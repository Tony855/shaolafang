# 🍖 烧腊坊扫码点餐系统 (Roast House Ordering System)

多端餐饮点餐系统，支持顾客扫码点餐、管理后台、服务员端、后厨显示。

## 功能特性

- 📱 **顾客端** - 扫码点餐、多语言切换、呼叫服务员、催单、订单查看
- 🖥️ **管理后台** - 订单管理、菜单管理、桌台管理、货币管理、服务员管理、营业报表、数据导出、打印机管理、预约管理、销量排行
- 🛎️ **服务员端** - 代客下单、菜品上菜、订单结算、打印小票
- 👨‍🍳 **后厨显示** - 实时订单显示、菜品状态标记、打印后厨小票
- 🌍 **多语言** - 中文、英文、越南文、泰文、高棉文
- 💱 **多货币** - 支持5种货币，双币显示
- 🖨️ **小票打印** - 兼容多品牌 ESC/POS 网络打印机（EPSON、Star、Bixolon、佳博、芯烨等）
- 📊 **数据报表** - 每日营业报表、销量排行、时段分布
- 💾 **数据备份** - 自动备份、导出/导入

## 技术栈

- **后端**: Node.js + Express + MySQL
- **前端**: 原生 HTML/CSS/JavaScript
- **打印**: ESC/POS 协议，支持 58mm/80mm 纸宽

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境

复制 `.env.example` 为 `.env` 并修改配置：

```bash
cp .env.example .env
```

编辑 `.env`：
```
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_password
DB_DATABASE=ordering_system
DB_PORT=3306
```

### 3. 初始化数据库

```bash
node server.js --init-only
```

### 4. 启动服务器

```bash
node server.js
```

### 5. 访问系统

- 顾客点餐: http://localhost:3000/index.html
- 管理后台: http://localhost:3000/admin.html
- 服务员端: http://localhost:3000/waiter.html
- 后厨显示: http://localhost:3000/kitchen.html
- 登录页: http://localhost:3000/login.html

## 默认管理员

- 后台密钥: `admin-key-2026`
- 管理员密码: `admin123`（首次登录后请修改）

## 项目结构

```
├── server.js              # 后端服务器
├── index.html             # 顾客点餐页
├── admin.html             # 管理后台
├── waiter.html            # 服务员端
├── kitchen.html           # 后厨显示
├── login.html             # 登录页
├── languages.js           # 多语言翻译
├── package.json           # 依赖配置
├── .env.example           # 环境变量模板
├── assets/
│   ├── common.css         # 统一样式
│   └── common.js          # 统一工具库 (SLF)
└── data/
    ├── roast-meat-menu.json  # 菜单初始化数据
    └── tables.json           # 桌台初始化数据
```

## API 接口

### 公共接口
- `GET /api/health` - 健康检查
- `GET /api/menu` - 获取菜单
- `GET /api/tables` - 获取桌台
- `GET /api/public/config` - 获取公共配置
- `POST /api/orders` - 创建订单
- `POST /api/orders/:id/urge` - 催单

### 管理接口 (需 X-Admin-Key)
- `GET /api/orders` - 订单列表
- `PUT /api/orders/:id` - 更新订单
- `DELETE /api/orders/:id` - 删除订单
- `GET/POST/PUT/DELETE /api/admin/menus` - 菜单管理
- `GET/POST/PUT/DELETE /api/admin/tables` - 桌台管理
- `GET/POST/PUT/DELETE /api/admin/currencies` - 货币管理
- `GET/POST/PUT/DELETE /api/admin/waiters` - 服务员管理
- `GET/POST/PUT/DELETE /api/admin/printers` - 打印机管理
- `GET /api/admin/reports/daily` - 每日报表
- `GET /api/admin/export/:type` - 数据导出
- `POST /api/orders/:id/print` - 打印订单
- `POST /api/orders/:id/print-kitchen` - 打印后厨小票

## 打印机配置

在管理后台 → 打印机管理中添加网络打印机：
- 打印机名称
- IP 地址
- 端口（默认 9100）
- 纸宽（58mm 或 80mm）
- 品牌（通用/EPSON/Star/Bixolon/佳博/芯烨/容大/弘印）

## 许可证

MIT
