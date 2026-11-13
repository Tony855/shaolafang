# FoodFlow · 多商户餐饮扫码点餐与门店运营系统

FoodFlow 是基于 Node.js、Express、MariaDB 和 Socket.IO 的餐饮运营系统，覆盖顾客扫码点餐、服务员桌台操作、后厨出餐、收银结算、商户运营管理及平台级管理。

> 本仓库：`Tony855/shaolafang`  
> 默认分支：`main`  
> 生产部署入口：Linux 一键安装向导 `install.sh`  
> 详细部署手册：[`INSTALL.md`](./INSTALL.md)、[`DEPLOY-STANDARD.md`](./DEPLOY-STANDARD.md)、[`DEPLOY-ENTERPRISE.md`](./DEPLOY-ENTERPRISE.md)

---

## 目录

- [1. 项目概览](#1-项目概览)
- [2. 功能模块与使用说明](#2-功能模块与使用说明)
- [3. 技术架构](#3-技术架构)
- [4. 系统要求与部署规划](#4-系统要求与部署规划)
- [5. Linux 一键安装部署（推荐）](#5-linux-一键安装部署推荐)
- [6. 手动安装部署](#6-手动安装部署)
- [7. 域名、Nginx 与 HTTPS](#7-域名nginx-与-https)
- [8. 首次登录与初始化](#8-首次登录与初始化)
- [9. 各端功能使用教程](#9-各端功能使用教程)
- [10. 多商户、门店与权限模型](#10-多商户门店与权限模型)
- [11. 多语言、多货币与打印机](#11-多语言多货币与打印机)
- [12. 财务、退款与对账说明](#12-财务退款与对账说明)
- [13. 环境变量配置](#13-环境变量配置)
- [14. 日常运维与版本升级](#14-日常运维与版本升级)
- [15. 数据备份与恢复](#15-数据备份与恢复)
- [16. 测试与开发](#16-测试与开发)
- [17. 故障排查](#17-故障排查)
- [18. 安全与生产建议](#18-安全与生产建议)
- [19. 卸载](#19-卸载)
- [20. 文档与支持](#20-文档与支持)

---

## 1. 项目概览

### 1.1 系统端口与访问入口

| 使用角色 | 页面入口 | 用途 |
|---|---|---|
| 顾客 | `/` | 扫码浏览菜单、购物车、下单、查看订单、呼叫服务员 |
| 管理员 | `/login`、`/admin` | 商户与门店日常运营管理 |
| 服务员 | `/waiter` | 桌台、订单、上菜与服务操作 |
| 后厨 | `/kitchen` | Kitchen Display System（KDS）出餐队列 |
| 收银员 | `/cashier` | 收款、找零、退款及收银操作 |
| 超级管理员 | `/super/login`、`/super` | 平台级商户、系统及运营管理 |

页面是否允许访问以及可执行的操作，均由服务端会话、角色和权限校验决定；不要将隐藏前端按钮视为安全边界。

### 1.2 主要能力

- 顾客桌台二维码点餐、菜单浏览、购物车、提交订单和订单状态查看。
- 服务员桌台管理、开台、换桌、并台、代客下单、上菜、退菜及订单处理。
- 后厨订单实时显示、菜品完成标记、出餐与打印工作流。
- 收银台订单结算、现金收款与找零、配置的电子/扫码支付方式、退款和小票。
- 商户后台菜单、分类、桌台、订单、门店、员工、收银员、打印机、货币、报表和日志管理。
- 平台超级管理端的商户/门店管理、平台设置、登录及操作审计等能力。
- 多语言界面：中文、English、Tiếng Việt、ภาษาไทย、ភាសាខ្មែរ。
- 多币种及主币种/副币种显示，汇率由管理端配置。
- Socket.IO 实时事件推送；可配置 Redis adapter 支持多应用节点间事件转发。
- ESC/POS 网络打印（常见 RAW TCP 9100），并提供浏览器打印等操作路径。
- 数据库初始化与增量兼容迁移、定时任务、备份和运维脚本。
- 财务流水基础能力与对账导入/匹配审核工作流；具体边界见[财务说明](#12-财务退款与对账说明)。

---

## 2. 功能模块与使用说明

### 2.1 顾客扫码点餐

1. 管理员先创建门店、桌台并生成桌台二维码。
2. 将对应二维码打印并放置在实际桌位。
3. 顾客使用手机相机或扫码软件打开二维码。
4. 浏览分类和菜品，选择规格/数量（以当前菜单配置为准）并加入购物车。
5. 核对订单内容后提交。
6. 在顾客页面查看订单进度；需要服务时可使用呼叫服务员等入口。

**运营提示：** 新初始化的示例菜品可能处于下架状态。正式营业前，应在菜单管理中检查价格、分类、图片、可售状态和所属门店。

### 2.2 服务员端

服务员使用管理员创建的服务员账号登录。常用流程：

- 查看负责门店的桌台状态和当前订单。
- 根据门店实际流程开台、换桌或并台。
- 为顾客代客下单，或协助处理顾客提交的订单。
- 按菜品/订单状态进行上菜、退菜或完成操作。
- 查看订单历史并处理顾客服务呼叫。

服务员可以执行的操作受服务员账号能力配置、所属商户/门店和服务端校验约束。

### 2.3 后厨 KDS

后厨使用专用设备或浏览器打开 `/kitchen`：

- 查看新订单及实时更新的订单队列。
- 根据出餐流程标记菜品或订单完成。
- 通过全屏页面在后厨屏幕持续显示任务。
- 如已配置后厨打印机，可配合打印出餐票。

建议后厨设备使用稳定的局域网连接，并关闭浏览器自动休眠。

### 2.4 收银台

收银员从 `/cashier` 进入收银工作区。常见操作包括：

- 查找待结算订单并核对桌号、商品、数量和金额。
- 根据门店启用的支付配置选择收款方式。
- 现金收款时录入实收金额并核对找零。
- 按当前角色权限执行结算、退款或查看报表。
- 打印或补打收据（具体打印路径取决于打印机配置）。

**支付说明：** 页面出现的支付渠道不代表系统已自动开通对应银行/支付机构的商户账户或 API。第三方支付的收款确认、回调验签、退款能力和生产密钥，必须按该渠道的正式接入配置完成后才能用于真实交易。

### 2.5 商户管理后台

管理员登录后进入 `/admin`，根据权限管理：

| 模块 | 常见操作 |
|---|---|
| 菜单与分类 | 新增/编辑菜品、分类、价格、图片、上下架 |
| 桌台管理 | 创建桌台、调整桌台信息、生成二维码 |
| 订单管理 | 查看订单、处理订单状态及授权范围内的修改/取消 |
| 门店管理 | 维护门店信息及门店级业务配置 |
| 服务员管理 | 创建服务员账号、设置所属门店及可执行能力 |
| 收银员管理 | 创建收银员并配置收银操作权限 |
| 货币设置 | 设置主/副货币、显示规则和汇率 |
| 打印机管理 | 配置打印机用途、地址、端口、纸宽并测试 |
| 报表与日志 | 查看系统提供的经营统计、操作记录和相关日志 |
| 财务对账 | 在具备相应权限时查看导入批次、流水匹配建议和人工审核记录 |

菜单名称和可用操作会随账号权限、部署版本及当前商户配置变化。

### 2.6 超级管理员平台

超级管理员入口为 `/super/login`，管理界面为 `/super`。用于平台运营人员执行平台级管理，例如：

- 创建、编辑、启用或停用商户。
- 查看商户及门店概览。
- 管理平台级设置。
- 查看登录记录、操作审计和平台运行信息。
- 使用系统提供的数据备份/恢复管理能力。

超级管理员账号与商户管理员账号是不同的身份体系。请限制超级管理员入口的网络访问，并使用独立的高强度密码。

---

## 3. 技术架构

| 层级 | 技术 |
|---|---|
| Web 服务 | Node.js 26 LTS、Express 4 |
| 实时通信 | Socket.IO 4 |
| 数据库 | MariaDB 10.5+ |
| 可选缓存与跨节点适配 | Redis、Socket.IO Redis Adapter |
| 前端 | 原生 JavaScript、HTML、CSS |
| 多语言 | 语言资源文件及构建/检查脚本 |
| 打印 | ESC/POS 网络打印，常见 TCP 9100 |
| 进程管理 | systemd |
| 反向代理与 TLS | Nginx、Certbot / Let's Encrypt |
| 自动化测试 | Node.js 内置 test runner |

### 3.1 逻辑架构

```text
顾客手机 / 服务员平板 / 后厨屏幕 / 收银终端 / 管理员浏览器
                         |
                      HTTPS
                         |
                    Nginx 反向代理
                         |
                  Node.js / Express
                    |          |
                Socket.IO    REST API
                    |          |
                    +-----+----+
                          |
                 MariaDB
                          |
                  Redis（可选）
                          |
              上传文件 / 备份 / 网络打印机
```

单机部署时应用、数据库和可选 Redis 可以位于同一服务器。多节点部署时，应使用共享 Redis、共享上传存储，并确保所有应用节点使用相同的数据库和关键配置。

---

## 4. 系统要求与部署规划

### 4.1 软件要求

- Linux 推荐 Debian 12/13 或 Ubuntu 22.04/24.04。
- Node.js 26 LTS（npm 10+）。
- MariaDB 10.5+。
- Git、npm。
- Nginx 用于域名反向代理和 HTTPS（生产环境推荐）。
- Redis 为可选组件；启用多节点部署时，应按对应部署手册配置共享 Redis。

### 4.2 资源建议

以下为初始规划参考，实际资源需按订单量、图片数量、在线连接数、报表查询和数据库负载压测调整。

| 场景 | 建议起步配置 | 部署建议 |
|---|---|---|
| 本地开发/演示 | 2 vCPU / 2 GB RAM | 本机数据库或测试数据库 |
| 小型单机生产 | 2–4 vCPU / 4–8 GB RAM | 应用 + 数据库同机 |
| 应用与数据库分离 | 应用 2–4 vCPU / 4–8 GB；数据库独立 | 内网连接数据库 |
| 多应用节点 | 每节点按压测配置 | 共享数据库、Redis、上传存储及负载均衡 |

> 部署目录中的门店数量和并发数字属于规划参考，不是对任意硬件、数据库配置或业务负载的性能保证。上线前必须压测并验证故障恢复能力。

### 4.3 选择部署方式

| 方式 | 适用场景 | 参考文档 |
|---|---|---|
| 单机标准部署 | 开发、试运行、小型门店 | [标准部署指南](./deploy/standard/README.md) |
| 双应用节点 | 需要应用层冗余的业务 | [企业部署指南](./deploy/enterprise/README.md) |
| 多节点集群 | 多商户平台及水平扩展规划 | [企业旗舰部署目录](./deploy/enterprise-ultimate/README.md) |

请注意：集群部署并不自动等于数据库高可用。数据库、Redis、共享存储、负载均衡和备份系统都需要单独设计、配置和演练。

---

## 5. Linux 一键安装部署（推荐）

仓库根目录的 `install.sh` 首次运行默认执行**单机最小安装**，不再要求先选择企业集群模式。请在新建或已准备好的 Linux 服务器上执行，并在执行前阅读脚本及备份现有数据。

### 5.1 准备服务器

以 Debian/Ubuntu 为例：

```bash
sudo apt update
sudo apt install -y git curl ca-certificates
```

建议先完成以下准备：

- 为服务器配置固定公网 IP 或域名。
- 域名 A/AAAA 记录指向正确服务器。
- 确保 SSH 管理通道可用。
- 生产数据库和上传目录已有备份策略。
- 规划数据库密码、应用运行用户、备份保存位置和防火墙规则。

### 5.2 获取代码

```bash
sudo mkdir -p /opt
sudo chown "$USER":"$USER" /opt
cd /opt
git clone https://github.com/Tony855/shaolafang.git
cd shaolafang
```

### 5.3 运行安装向导

```bash
sudo bash install.sh
```

安装器统一配置 Node.js 26 LTS、系统基础工具和锁定的生产依赖；默认只刷新 APT 索引并安装所需组件，不会在安装过程中执行整机升级或删除现有数据库目录。若已安排系统维护窗口，并明确需要同时升级所有 Debian/Ubuntu 软件包，可显式执行：

```bash
sudo FF_APT_UPGRADE=1 bash install.sh
```

首次安装默认只准备单机运行所需的 Node.js 26、MariaDB、生产依赖、应用服务和 Nginx 反向代理。Redis、自动备份计划任务和防火墙规则默认不自动启用；单机模式可在确认需要后显式启用：

```bash
# 可选：安装并启用本机 Redis（单机默认可使用进程内缓存）
sudo FF_INSTALL_REDIS=1 bash install.sh

# 整机升级仍需维护窗口内显式启用
sudo FF_APT_UPGRADE=1 bash install.sh
```

企业部署不再出现在首次安装菜单中，需明确指定：

```bash
sudo bash install.sh enterprise master
sudo bash install.sh enterprise-ultimate master
```

双机/多节点部署必须先准备独立数据库、共享 Redis、共享上传存储、负载均衡和可信代理配置，并按对应部署目录文档执行。不要把单机配置直接复制到集群节点。

### 5.4 安装后检查

```bash
sudo systemctl status foodflow
sudo journalctl -u foodflow -n 100 --no-pager
curl -i http://127.0.0.1:3000/api/health
```

如果部署时修改了端口，请将上面的 `3000` 替换为实际 `PORT`。

确认服务正常后，再配置 Nginx、域名和 HTTPS。生产环境通常只对公网开放 SSH、HTTP、HTTPS；Node.js 和数据库端口不应直接暴露公网。

---

## 6. 手动安装部署

本节适用于希望自行管理 Node.js、数据库和服务进程的场景。集群部署请改用对应的集群部署手册。

### 6.1 安装 Node.js

生产环境统一使用 Node.js 26 LTS（npm 10+），开发环境请使用仓库根目录的 `.nvmrc`。安装后验证：

```bash
node --version
npm --version
```

### 6.2 安装并准备数据库

安装并启动 MariaDB 10.5+（Debian/Ubuntu 可使用 `sudo apt-get install mariadb-server` 和 `sudo systemctl enable --now mariadb`），然后创建独立数据库用户。示例（请替换密码）：

```sql
CREATE DATABASE foodflow_system
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER 'foodflow'@'127.0.0.1'
  IDENTIFIED BY '替换为强随机密码';

GRANT ALL PRIVILEGES ON foodflow_system.*
  TO 'foodflow'@'127.0.0.1';

FLUSH PRIVILEGES;
```

如果应用通过 `localhost` 而不是 `127.0.0.1` 连接数据库，请按 MariaDB 用户的 host 匹配规则创建授权。远程数据库只允许应用服务器内网地址访问，不要开放给整个互联网。

### 6.3 配置环境变量

```bash
cd /opt/shaolafang
cp .env.example .env
nano .env
```

最小配置示例：

```dotenv
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=foodflow_system
DB_USER=foodflow
DB_PASSWORD=替换为强随机密码
UPLOAD_DIR=./uploads
RUN_SCHEDULED_TASKS=false
CORS_ORIGINS=
TRUST_PROXY=loopback
```

`DB_DATABASE` 必须配置，且只能包含字母、数字、下划线或连字符。不要把真实密码提交到 Git。

### 6.4 安装依赖与启动

```bash
npm ci --omit=dev
node server.js
```

看到服务启动日志后，在服务器本机执行：

```bash
curl -i http://127.0.0.1:3000/api/health
```

开发环境可使用：

```bash
npm ci
npm run dev
```

生产环境不要依赖终端前台进程；请配置 systemd 或使用仓库部署脚本生成的服务配置。

### 6.5 systemd 服务

如果没有使用部署脚本创建服务，可按实际应用目录和运行用户建立服务文件：

```ini
[Unit]
Description=FoodFlow Ordering System
Wants=network-online.target
After=network-online.target mariadb.service

[Service]
Type=simple
User=foodflow
Group=www-data
WorkingDirectory=/opt/shaolafang
EnvironmentFile=/opt/shaolafang/.env
ExecStart=/usr/bin/node /opt/shaolafang/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

确保 `foodflow` 系统用户存在，并与安装脚本保持一致地使用 `www-data` 组。应用代码只读，上传、备份和日志目录由服务账号写入：

```bash
sudo useradd --system --no-create-home --home-dir /opt/shaolafang --shell /usr/sbin/nologin --gid www-data foodflow 2>/dev/null || true
sudo chown -R root:www-data /opt/shaolafang
sudo install -d -o foodflow -g www-data -m 0770 /opt/shaolafang/uploads /opt/shaolafang/backups /opt/shaolafang/logs
sudo install -d -o foodflow -g www-data -m 0700 /var/lib/foodflow
sudo chown root:www-data /opt/shaolafang/.env
sudo chmod 0640 /opt/shaolafang/.env
```

数据库服务使用 `mariadb.service`。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now foodflow
sudo systemctl status foodflow
```

> 如果仓库安装脚本已经创建 `foodflow.service`，优先使用脚本生成的配置，不要重复创建或覆盖。

---

## 7. 域名、Nginx 与 HTTPS

仓库提供 `setup-nginx.sh`，用于配置 Nginx 反向代理并在提供域名/邮箱时尝试申请 Let's Encrypt 证书。

### 7.1 DNS 与防火墙

1. 将域名 A 记录指向服务器 IPv4；如启用 IPv6，确认 AAAA 记录和服务器 IPv6 路由正确。
2. 云厂商安全组及系统防火墙开放 TCP 80、443。
3. 保留 SSH 管理端口；不要将 MariaDB 3306、Redis 6379 或应用端口 3000 暴露给公网。

### 7.2 使用仓库脚本

在仓库目录执行：

```bash
sudo bash setup-nginx.sh
```

按提示输入域名和证书邮箱。若暂时没有域名，可跳过证书配置，先使用 HTTP 在受控网络中测试。申请证书前，域名必须解析到本机且公网 80/443 可访问。

也可在 `.env` 中预先设置脚本读取的 `DOMAIN` 或 `QR_DOMAIN`、`EMAIL` 和 `PORT`。具体行为以当前 `setup-nginx.sh` 为准。

### 7.3 验证

```bash
sudo nginx -t
sudo systemctl status nginx
sudo systemctl reload nginx
curl -I https://你的域名/
```

Socket.IO 需要 Nginx 正确转发 HTTP Upgrade。使用仓库脚本生成的配置时不要随意删除 WebSocket 相关代理头。

---

## 8. 首次登录与初始化

### 8.1 初始账号凭据

首次初始化会生成随机初始密码，不应使用网上复制的固定默认密码。

在默认安装路径下，初始凭据文件为：

```text
/var/lib/foodflow/initial-credentials.txt
```

文件应仅允许服务器管理员读取（权限目标为 `0600`）。请通过 SSH 登录服务器后在本机安全读取：

```bash
sudo ls -l /var/lib/foodflow/initial-credentials.txt
sudo cat /var/lib/foodflow/initial-credentials.txt
```

请勿将凭据发到聊天群、工单、截图或提交到 Git。首次登录后立即修改密码，并在安全保存新凭据后按组织的凭据管理流程处理初始化文件。

首次安装账号可能包含平台超级管理员、商户管理员和服务员初始化身份；实际账号清单以安装脚本输出的凭据文件为准。收银员通常由商户管理员在后台创建。

### 8.2 最小首次运行检查

安装程序会自动检查必填数据库配置、systemd 服务、应用与数据库健康状态，以及初始超级管理员凭据文件是否存在且未向组/其他用户开放。检查不会读取或输出密码。

需要重新检查时，在服务器执行：

```bash
sudo bash /var/www/foodflow/scripts/first-run-check.sh
```

健康检查接口为 `GET /health`：数据库可用时返回 HTTP 200；数据库不可用时返回 HTTP 503。响应不包含数据库地址、账号、密码或异常详情。首次安装默认关闭后台定时任务（包括自动备份）；需要时在确认备份目录、保留策略和存储空间后，再将 `.env` 中的 `RUN_SCHEDULED_TASKS` 显式设为 `true` 并重启服务。

首次登录入口：
- 平台超级管理员：`/super/login`
- 商户管理员：`/login`

### 8.3 初始化数据

首次数据库初始化可能写入示例菜单、分类、货币和桌台数据。示例数据用于验证流程，不代表真实营业配置。上线前请逐项检查并替换为实际商户数据。

### 8.4 首次上线检查清单

- [ ] 修改所有初始账号密码。
- [ ] 检查商户、门店和桌台信息。
- [ ] 检查菜品、分类、价格、图片及上下架状态。
- [ ] 设置主货币、副货币及汇率。
- [ ] 创建服务员和收银员并限制权限。
- [ ] 配置打印机并进行实际测试打印。
- [ ] 配置支付渠道并完成真实/沙箱验证。
- [ ] 验证 HTTPS、扫码下单、后厨出餐、收银结算和退款流程。
- [ ] 验证备份、恢复和日志轮转。
- [ ] 确认数据库、Redis 和应用端口没有公网暴露。

---

## 9. 各端功能使用教程

### 9.1 管理员推荐配置顺序

首次使用建议按以下顺序完成配置：

1. 登录管理员后台。
2. 核对商户及当前门店信息。
3. 创建或检查菜品分类。
4. 添加菜品、价格、图片及销售状态。
5. 创建桌台并生成二维码。
6. 配置货币及显示规则。
7. 创建服务员和收银员账号。
8. 添加前台及后厨打印机并测试。
9. 完成支付渠道配置和测试。
10. 用测试桌台走通顾客下单、服务员处理、后厨出餐、收银结算完整流程。

### 9.2 菜单与桌台

- 菜品上架前检查名称、分类、价格和图片。
- 暂停销售的菜品应设置为下架，而不是删除历史订单所引用的数据。
- 桌台二维码应与实际桌号一一对应。
- 桌台移动、合并或重新编号后，应检查二维码是否仍指向预期桌台。
- 在正式打印二维码前，用不同手机验证扫码和会话流程。

### 9.3 订单处理建议

- 顾客提交后，服务员/后厨按实际职责处理。
- 出餐完成状态应由实际操作人员确认。
- 取消、退菜、退款等操作应核对订单和金额，并保留业务凭证。
- 不要直接修改生产数据库中的订单金额或支付状态来解决业务问题。

### 9.4 员工管理

- 每位员工使用独立账号，不共享管理员密码。
- 账号仅授予岗位所需权限。
- 员工离职或岗位变更时及时停用账号、调整权限。
- 定期查看登录日志和操作日志，排查异常访问。

---

## 10. 多商户、门店与权限模型

系统按认证上下文确定商户和门店范围。请求参数不能被当作可信的跨商户授权依据。平台管理、商户管理和员工操作应使用各自的身份与权限入口。

### 10.1 管理角色

| 角色 | 职责 |
|---|---|
| 平台超级管理员 | 平台级商户、全局配置及审计管理 |
| 商户主管理员 | 管理本商户的门店、员工、菜单和运营设置 |
| 商户子管理员 | 按授权权限执行运营或设置工作 |
| 服务员 | 执行被授予的桌台、订单和服务操作 |
| 收银员 | 执行被授予的收款、结算、退款等收银操作 |
| 顾客 | 浏览菜单、下单及查看自身订单相关信息 |

### 10.2 权限管理原则

商户管理员权限覆盖菜单、桌台、订单、取消/编辑订单、门店、服务员、货币、打印机、管理员、日志、收银员及财务对账等管理范围。实际权限字段及默认值以当前代码和数据库迁移为准。

- 主管理员拥有必要的管理能力，关键保护规则由服务端执行。
- 子管理员只应获得完成岗位职责所需的权限。
- 收银员的结算、取消、退款和报表能力应分别控制（以当前实现为准）。
- 服务员的订单/菜品操作能力应按岗位配置。
- 财务对账审核权限应单独授予，不应默认开放给普通员工。

---

## 11. 多语言、多货币与打印机

### 11.1 多语言

当前项目包含中文、英语、越南语、泰语和高棉语语言资源。各端根据界面语言资源展示文本。

开发者修改语言资源后，可执行：

```bash
npm run build:lang
npm run check:lang
```

严格检查：

```bash
npm run check:lang:strict
```

### 11.2 多货币

- 设置主货币和副货币。
- 按门店业务维护汇率。
- 核对订单、收银、报表和小票的金额显示。
- 汇率变更前确认对新旧订单展示和财务核对的影响。

系统显示多货币金额不等于自动完成外汇结算；实际收款币种和会计入账规则应由商户明确。

### 11.3 ESC/POS 网络打印机

常见网络打印机通过 TCP RAW 9100 端口通信。建议配置：

| 配置项 | 示例 |
|---|---|
| 打印机名称 | 前台小票机 / 后厨打印机 |
| 用途 | 收银小票 / 厨房出餐票 |
| IP 地址 | 192.168.1.100（示例） |
| 端口 | 9100（以设备设置为准） |
| 纸宽 | 58mm 或 80mm |
| 协议 | ESC/POS（设备兼容时） |

配置步骤：

1. 为打印机设置固定局域网 IP。
2. 确保应用服务器可以访问打印机 IP 和打印端口。
3. 在管理员后台的打印机管理中添加设备。
4. 选择正确的用途、纸宽和设备参数。
5. 使用测试打印检查中文、金额、二维码/条码（若设备支持）及纸张裁切。
6. 分别测试前台收据和后厨票据。

连通性检查：

```bash
ping 192.168.1.100
nc -zv 192.168.1.100 9100
```

不要把打印机端口开放到公网。网络打印机通常应放在门店局域网内。

---

## 12. 财务、退款与对账说明

财务功能需要区分“业务订单/支付记录”“内部财务流水”“外部银行或支付机构对账单”三个层次。

### 12.1 已有财务能力边界

当前代码包含订单/退款财务服务、财务流水基础设施，以及 provider-neutral（不绑定特定支付机构）的对账导入和匹配建议/人工审核能力。

- 对账导入使用规范化后的批次和行记录。
- 导入批次具有商户、门店、provider、外部批次标识和原始文件 SHA-256 摘要等校验信息。
- 匹配建议按精确引用、商户/门店范围、金额最小单位和币种等规则判断。
- 建议结果可能为 suggested、ambiguous、unmatched 或 exception。
- 匹配建议本身不是确认结果，不应自动改变订单、退款或会计流水。
- 人工审核动作由具备财务对账权限的用户执行，并保留审计信息。

### 12.2 尚需外部规格/财务审批的事项

不要把当前 provider-neutral 导入能力描述为已完成某家银行的全自动直连。以下事项需要官方接口/文件规范和财务确认后单独实施：

- ABA PayWay、Bakong 或其他机构的专有文件解析/API 接入。
- Webhook/callback 签名验证及支付状态同步。
- 银行借贷方向映射、手续费、结算差额和退款/拒付规则。
- 外币换算、汇兑差额和正式会计科目映射。
- 自动确认匹配、自动生成会计分录或自动修改订单支付状态。

更多设计边界见：
- [财务流水基础说明](./docs/FINANCIAL-RECONCILIATION-FOUNDATION.md)
- [财务匹配建议规则](./docs/FINANCIAL-RECONCILIATION-MATCH-SUGGESTIONS.md)

生产财务操作前，务必在测试环境使用脱敏样本验证导入、重复导入、异常匹配、人工审核、权限隔离和备份恢复。

---

## 13. 环境变量配置

根目录 `.env.example` 是当前应用配置模板。主要变量如下：

| 变量 | 说明 | 默认/示例 |
|---|---|---|
| `PORT` | Node.js HTTP 监听端口 | `3000` |
| `DB_HOST` | MariaDB 地址 | `127.0.0.1` |
| `DB_PORT` | 数据库端口 | `3306` |
| `DB_DATABASE` | 数据库名称，必填 | `foodflow_system` |
| `DB_USER` | 数据库用户名 | `foodflow` |
| `DB_PASSWORD` | 数据库密码 | 必须替换 |
| `UPLOAD_DIR` | 上传文件目录 | `./uploads` |
| `RUN_SCHEDULED_TASKS` | 是否运行本节点定时任务 | `true` |
| `CORS_ORIGINS` | 允许的跨域来源，逗号分隔 | 空值表示不额外开放跨域来源 |
| `TRUST_PROXY` | 可信反向代理配置 | `loopback` |

代码还支持数据库连接池等部署相关配置；集群模式请以对应的 `.env.example` 为准。

### 13.1 单节点与多节点注意事项

- 单机模式通常由该节点执行定时任务。
- 多应用节点模式应只让指定主节点运行定时任务，其余节点设置为关闭，避免重复执行。
- 多节点必须使用一致的数据库、Redis、会话相关密钥和共享上传存储配置。
- `TRUST_PROXY` 只应信任真实的反向代理地址/网段；不要在不可信网络中盲目设为信任所有代理。
- 修改环境变量后需要重启应用服务。

---

## 14. 日常运维与版本升级

### 14.1 常用服务命令

```bash
# 查看状态
sudo systemctl status foodflow

# 重启 / 停止 / 启动
sudo systemctl restart foodflow
sudo systemctl stop foodflow
sudo systemctl start foodflow

# 实时查看应用日志
sudo journalctl -u foodflow -f

# 查看最近 200 行
sudo journalctl -u foodflow -n 200 --no-pager

# 查看 Nginx 配置并重载
sudo nginx -t
sudo systemctl reload nginx

# 查看监听端口
sudo ss -lntp
```

### 14.2 升级前准备

1. 阅读 CHANGELOG 和本次版本迁移说明。
2. 确认数据库和上传文件备份可用。
3. 记录当前 Git commit、Node.js 版本和环境变量。
4. 在测试环境完成升级和回滚演练。
5. 安排维护窗口并通知门店人员。

### 14.3 单节点升级参考

在已确认部署目录和 Git 工作区无本地未提交改动后：

```bash
cd /opt/shaolafang
sudo systemctl stop foodflow
git status --short
git fetch origin
git pull --ff-only origin main
npm ci --omit=dev
sudo systemctl start foodflow
sudo systemctl status foodflow
curl -i http://127.0.0.1:3000/api/health
```

请根据真实安装路径调整命令。若使用部署脚本将代码安装到 `/var/www/foodflow`，应进入该目录操作。若 Git 工作区有本地修改，先检查并妥善保存，不要直接覆盖。

数据库初始化/迁移由应用启动流程管理；升级前必须确认当前版本迁移说明，并在备份后先于 staging 验证。不要为了“修复启动”而随意删除数据库或重建生产表。

### 14.4 多节点滚动升级

- 先确认共享数据库、Redis 和共享上传存储健康。
- 按部署手册逐个升级应用节点。
- 每升级一个节点，检查服务状态、健康检查、Socket.IO 连接及关键业务流程。
- 定时任务只能由指定节点执行。
- 所有节点版本一致且验证通过后，再结束维护窗口。

---

## 15. 数据备份与恢复

### 15.1 数据库手动备份

```bash
mariadb-dump --single-transaction --routines --triggers \
  -h 127.0.0.1 -P 3306 -u foodflow -p foodflow_system \
  > foodflow_$(date +%F_%H%M%S).sql
```

### 15.2 数据库恢复

先在隔离环境验证备份，再恢复到目标数据库：

```bash
mariadb -h 127.0.0.1 -P 3306 -u foodflow -p foodflow_system < foodflow_backup.sql
```

恢复会覆盖/写入目标库中的数据。生产恢复前应停止写入、另做当前状态备份，并确认目标数据库名称。

### 15.3 上传文件与配置备份

数据库备份不包含所有上传文件、`.env`、Nginx 配置和服务器证书。请分别备份：

- `UPLOAD_DIR` 指定的上传目录。
- `backups/` 或实际配置的备份目录。
- `.env`（加密保存，严格限制访问）。
- Nginx、systemd 和部署配置。
- 证书续期配置及必要的运维文档。

备份文件应复制到异机或对象存储，设置访问控制和保留周期。定期进行完整恢复演练；仅看到备份文件存在并不能证明备份可恢复。

---

## 16. 测试与开发

### 16.1 安装开发依赖

```bash
npm ci
```

### 16.2 常用脚本

| 命令 | 用途 |
|---|---|
| `npm start` | 启动服务 |
| `npm run dev` | 使用 nodemon 启动开发服务 |
| `npm test` | 运行 Node.js 测试套件 |
| `npm run build:lang` | 构建语言资源 |
| `npm run check:lang` | 检查语言资源 |
| `npm run check:lang:strict` | 严格语言资源检查 |
| `npm run build:admin` | 构建管理端 bundle |

提交 PR 前建议执行：

```bash
npm test
npm run check:lang
npm run build:admin
git diff --check
```

若本次改动涉及语言资源，再执行 `npm run build:lang` 和 `npm run check:lang:strict`。CI 工作流的实际检查项以 `.github/workflows/ci.yml` 为准。

### 16.3 项目目录

```text
.
├── assets/                 # 前端 CSS、JS、图标和静态资源
├── deploy/                 # 标准版/企业版/旗舰版部署配置
├── docs/                   # 业务与技术设计文档
├── locales/                # 多语言资源
├── pages/                  # 页面资源
├── routes/                 # Express 路由模块
├── scripts/                # 构建、检查和维护脚本
├── server/                 # 服务端配置、服务、工具及中间件
├── tests/                  # 自动化测试
├── uploads/                # 运行时上传目录（部署后生成/配置）
├── server.js               # 应用入口
├── install.sh              # Linux 部署模式向导
├── install-local.sh        # 本地/单机安装辅助脚本
├── setup-nginx.sh          # Nginx 与 HTTPS 配置脚本
├── uninstall.sh            # 卸载脚本
└── package.json            # 依赖与 npm scripts
```

---

## 17. 故障排查

### 17.1 服务无法启动

```bash
sudo systemctl status foodflow
sudo journalctl -u foodflow -n 150 --no-pager
node --version
npm --version
```

检查 Node.js 版本、依赖安装、工作目录、`.env` 权限和端口占用。

### 17.2 数据库连接失败

常见错误：`ECONNREFUSED`、`Access denied`。

```bash
sudo systemctl status mariadb
sudo systemctl status mariadb
sudo ss -lntp | grep 3306
mariadb -h 127.0.0.1 -P 3306 -u foodflow -p
```

检查数据库服务是否运行、地址/端口是否正确、用户名 host 授权是否匹配，以及 `.env` 中的密码和数据库名。

### 17.3 Nginx 返回 502

```bash
sudo systemctl status foodflow
sudo journalctl -u foodflow -n 100 --no-pager
sudo nginx -t
sudo tail -n 100 /var/log/nginx/error.log
curl -i http://127.0.0.1:3000/api/health
```

通常是后端未启动、反向代理端口错误或 Nginx 无法连接本机后端。

### 17.4 页面可打开但实时更新失效

- 检查浏览器开发者工具中的 Socket.IO 连接。
- 确认 Nginx 转发 WebSocket Upgrade 请求。
- 多节点部署时检查 Redis 连接和 Redis adapter 配置。
- 检查负载均衡和代理超时设置。

### 17.5 图片无法显示

- 检查 `UPLOAD_DIR` 是否正确。
- 检查应用运行用户是否具有读写权限。
- 多节点部署时确认所有节点访问同一共享上传目录。
- 检查 Nginx 对上传静态资源路径的代理/映射配置。

### 17.6 打印失败

- 检查打印机 IP 是否固定且可达。
- 检查设备是否支持 ESC/POS 和对应纸宽。
- 检查 TCP 打印端口是否正确（常见 9100）。
- 检查应用服务器到门店局域网的路由、防火墙和 VLAN 访问策略。
- 在后台重新执行测试打印。

### 17.7 语言资源未更新

```bash
npm run build:lang
npm run check:lang
```

随后清除浏览器缓存或硬刷新页面，并检查前端资源版本是否更新。

### 17.8 数据库迁移或字段错误

- 先确认当前代码版本和 CHANGELOG。
- 检查应用启动日志中的迁移错误。
- 在备份后于 staging 运行相同版本进行验证。
- 不要通过删除生产数据表或手工随意改字段来绕过迁移问题。

---

## 18. 安全与生产建议

1. 使用独立数据库用户，不使用数据库 root 账号运行应用。
2. 所有初始密码和示例密码必须更换为随机强密码。
3. `.env`、凭据文件、数据库备份和证书私钥不得提交到 Git。
4. 生产环境使用 HTTPS，并正确设置可信代理。
5. 数据库、Redis、Node.js 应用端口仅允许必要的内网来源访问。
6. 平台超级管理员和财务对账权限采用最小授权、独立账号和定期审计。
7. 对支付渠道使用官方文档规定的签名验证、幂等键和回调校验。
8. 定期更新操作系统、Node.js 和 npm 依赖；升级前先在测试环境验证。
9. 对数据库和上传文件实施异地备份，并定期进行恢复演练。
10. 生产上线前压测并检查 CPU、内存、数据库连接池、磁盘、Redis 和日志容量。
11. 不要直接在生产数据库中修改订单、支付或退款记录。
12. 对外提供服务前完成权限隔离、跨商户访问、登录限流和备份恢复测试。

---

## 19. 卸载

仓库提供 `uninstall.sh`。执行前请先阅读脚本内容，确认它将删除哪些服务、目录和配置，并自行备份数据库、上传文件、`.env` 和证书。

```bash
cd /opt/shaolafang
sudo bash uninstall.sh
```

卸载脚本的实际清理范围以当前版本脚本为准。卸载后请检查 systemd 服务、Nginx 配置、定时任务、数据库和上传目录，确认没有遗留生产资源。

---

## 20. 文档与支持

| 文档 | 内容 |
|---|---|
| [安装指南 INSTALL.md](./INSTALL.md) | 安装方式、首次启动和常见安装问题 |
| [标准部署 DEPLOY-STANDARD.md](./DEPLOY-STANDARD.md) | 单机部署与标准运维 |
| [企业部署 DEPLOY-ENTERPRISE.md](./DEPLOY-ENTERPRISE.md) | 双应用节点部署 |
| [部署配置总览](./deploy/README.md) | 部署目录结构和模式选择 |
| [企业旗舰部署](./deploy/enterprise-ultimate/README.md) | 多节点集群部署 |
| [财务流水基础](./docs/FINANCIAL-RECONCILIATION-FOUNDATION.md) | 对账导入的数据模型和安全边界 |
| [财务匹配建议](./docs/FINANCIAL-RECONCILIATION-MATCH-SUGGESTIONS.md) | 精确匹配规则和建议状态 |

- GitHub 仓库：[https://github.com/Tony855/shaolafang](https://github.com/Tony855/shaolafang)
- Issues：[https://github.com/Tony855/shaolafang/issues](https://github.com/Tony855/shaolafang/issues)
- Pull Requests：[https://github.com/Tony855/shaolafang/pulls](https://github.com/Tony855/shaolafang/pulls)

---

## 许可与使用

本项目当前按私有项目方式管理。未经仓库所有者许可，请勿复制、分发或用于未授权的商业部署。
