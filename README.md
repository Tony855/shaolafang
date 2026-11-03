# FoodFlow · 多语言扫码点餐系统

> 一站式餐饮系统：顾客扫码点餐、服务员开台、后厨出单、收银结算、商户后台、超级管理员。

## 功能一览

| 端 | 路径 | 主要能力 |
|----|------|---------|
| 顾客 | `/` | 扫码绑定桌号、浏览菜单、加购物车、下单、查看订单、呼叫服务员、催单 |
| 服务员 | `/waiter` | 桌台状态、开台/换桌/并台、代客下单、上菜、退菜、结算、订单历史 |
| 后厨 KDS | `/kitchen` | 实时订单票、菜品完成标记、出餐打印、催单提示、全屏模式 |
| 收银台 | `/cashier` | POS 风格双栏、现金/扫码/刷卡/ABA 收款、找零、退款、小票打印 |
| 商户后台 | `/admin` | 菜品、分类、桌号、订单、店铺、服务员、收银员、打印机、货币、报表、日志 |
| 超级管理 | `/super` | 商户 CRUD、门店总览、服务器监控、在线会话、数据备份、全局设置 |

## 核心特性

- 多语言：中文 / English / Tiếng Việt / ภาษาไทย / ភាសាខ្មែរ，所有端实时切换
- 多商户 + 多店铺：数据按 merchant_id / store_id 严格隔离
- 双货币显示：主币种 + 副币种并存，汇率可配
- 实时同步：Socket.IO 按角色分房间推送，各端秒级更新
- ESC/POS 打印：支持网络打印机直打，另附浏览器打印兜底
- 订单号序列化：前缀(2) + 日期 + 序号，支持日/月/年/永久重置
- 权限系统：12 项细粒度权限，主管理员 / 子管理员分权
- 全链路审计：登录日志、操作日志、金额流水

## 技术栈

    后端   Node.js 20 · Express 4 · MySQL 8 / MariaDB 10.5+ · Socket.IO 4
    缓存   Redis（可选，未配则用内存）
    前端   原生 JS（无框架）· 多语言 JSON · 响应式 CSS
    打印   ESC/POS 网络协议（TCP 9100）
    部署   systemd + Nginx + Let's Encrypt

## 快速开始

一键安装（Linux 推荐）：

    git clone https://github.com/Tony855/shaolafang.git
    cd shaolafang
    sudo bash install.sh

手动部署：

    npm install --omit=dev
    cp .env.example .env
    node server.js

## 首次登录账号

首次初始化时，系统默认用户名为 `superadmin`、`admin`、`waiter`。密码由服务端随机生成，不再使用公开的固定默认密码。

首次初始化凭据写入服务器 `/var/lib/foodflow/initial-credentials.txt`，文件权限为 `0600`。请仅通过服务器本机安全渠道读取并立即修改密码。收银员由商户后台自行创建。

## 常用命令

    systemctl restart foodflow
    systemctl status foodflow
    journalctl -u foodflow -f
    npm run build:lang
    npm run check:lang

## 环境变量（.env）

| 变量 | 说明 | 默认 |
|------|------|------|
| PORT | 服务端口 | 3000 |
| DB_HOST / DB_PORT | 数据库地址 | 127.0.0.1:3306 |
| DB_DATABASE | 库名（必填） | — |
| DB_USER / DB_PASSWORD | 数据库账号 | foodflow / 随机 |
| UPLOAD_DIR | 上传目录 | ./uploads |
| REDIS_URL | Redis 连接串（可选） | 空 |
| RUN_SCHEDULED_TASKS | 是否跑定时任务 | false（安装器会在单机模式显式设为 true） |

## 权限说明

12 项权限，分 3 组：

- 运营管理：菜单、桌号、订单、取消订单、编辑订单
- 基础设置：门店、服务员、货币、打印机、收银员
- 系统管理：管理员、日志

主管理员（ID 最小）自动全权限，不可修改。

## 常见问题

Q：扫码后"会话已过期"？
A：二维码 session 在超管后台配置（默认 45 分钟），有未结算订单时自动续期。

Q：订单号重复？
A：order_sequences 表原子分配，并发极高时重试一次。

Q：收银员看不到某些按钮？
A：商户后台"收银员管理"里控制结算/取消/退款/报表权限。

Q：语言切换没变？
A：硬刷新 Ctrl+Shift+R，检查 languages.min.js?v=。

## 卸载

    sudo bash uninstall.sh

会卸载应用程序和服务。数据库默认保留；上传文件、备份和配置会先归档，避免误删生产数据。

## 许可

私有项目，未经许可请勿分发。
