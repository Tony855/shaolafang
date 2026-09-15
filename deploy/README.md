# FoodFlow 部署配置

本目录包含 FoodFlow 点餐系统的部署配置，按版本分类。

---

## 目录结构

```
deploy/
├── README.md                        # 本文件（总览）
├── standard/                        # 📦 标准版
│   ├── README.md                    # 标准版部署详细指南
│   └── cluster/                     # 2台服务器集群部署
│       ├── deploy.sh                # 一键部署脚本（master/slave）
│       ├── nginx.conf               # Nginx负载均衡配置
│       ├── foodflow.service         # Systemd服务配置
│       ├── .env.example             # 环境变量模板
│       ├── init-db.sh               # 数据库初始化脚本
│       └── setup-nfs-server.sh      # NFS共享存储配置
│
└── enterprise/                      # 🏢 企业版
    ├── README.md                    # 企业版部署详细指南
    └── cluster/                     # 多台服务器集群部署（可水平扩展）
        ├── deploy.sh                # 一键部署脚本（master/slave）
        ├── nginx.conf               # Nginx负载均衡配置（多节点）
        ├── foodflow.service         # Systemd服务配置
        ├── .env.example             # 环境变量模板（含企业版特有配置）
        ├── init-db.sh               # 数据库初始化脚本
        └── setup-nfs-server.sh      # NFS共享存储配置
```

---

## 版本对比

| 对比项 | 标准版 Standard | 企业版 Enterprise |
|--------|----------------|------------------|
| **定位** | 单个餐饮品牌 | 多商户/SaaS平台 |
| **适用规模** | 100-200家门店 | 200+家门店 |
| **应用服务器** | 2台（固定） | 3台起（可水平扩展） |
| **并发能力** | ~3,000同时在线 | 5,000+（可扩展） |
| **超级管理员后台** | ❌ | ✅ |
| **多商户管理** | ❌ | ✅ |
| **商户数据隔离** | 单商户 | 多商户严格隔离 |
| **商户编码自动生成** | ❌ | ✅ |
| **操作审计日志** | ❌ | ✅ |
| **登录日志** | ❌ | ✅ |
| **商户自助注册** | ❌ | ✅（可配置） |
| **数据库名** | foodflow_standard | foodflow_enterprise |
| **GitHub仓库** | foodflow-standard | foodflow-enterprise |

---

## 如何选择？

### 选择标准版，如果：
- 你是单个餐饮品牌/连锁企业
- 门店数量在100-200家之间
- 不需要管理多个独立商户
- 预算有限，需要高性价比方案
- 技术团队规模较小

### 选择企业版，如果：
- 你是餐饮SaaS平台/技术服务商
- 需要为多个餐饮品牌提供服务
- 门店数量超过200家，或未来会快速增长
- 需要超级管理员统一管理所有商户
- 需要完整的审计日志和合规能力
- 需要水平扩展能力应对业务增长

---

## 快速开始

### 标准版部署
```bash
# 查看详细指南
cat deploy/standard/README.md

# 1. 配置NFS
sudo bash deploy/standard/cluster/setup-nfs-server.sh

# 2. 初始化数据库
sudo bash deploy/standard/cluster/init-db.sh

# 3. 部署主节点
sudo bash deploy/standard/cluster/deploy.sh master

# 4. 部署从节点
sudo bash deploy/standard/cluster/deploy.sh slave

# 5. 配置Nginx
sudo cp deploy/standard/cluster/nginx.conf /etc/nginx/conf.d/foodflow.conf
sudo nginx -t && sudo systemctl reload nginx
```

### 企业版部署
```bash
# 查看详细指南
cat deploy/enterprise/README.md

# 1. 配置NFS
sudo bash deploy/enterprise/cluster/setup-nfs-server.sh

# 2. 初始化数据库
sudo bash deploy/enterprise/cluster/init-db.sh

# 3. 部署主节点
sudo bash deploy/enterprise/cluster/deploy.sh master

# 4. 部署从节点（可重复部署N台）
sudo bash deploy/enterprise/cluster/deploy.sh slave

# 5. 配置Nginx
sudo cp deploy/enterprise/cluster/nginx.conf /etc/nginx/conf.d/foodflow.conf
sudo nginx -t && sudo systemctl reload nginx
```

---

## 标准版 vs 企业版部署配置差异

### 环境变量差异

| 变量 | 标准版 | 企业版 |
|------|--------|--------|
| `APP_VERSION` | standard | enterprise |
| `DB_NAME` | foodflow_standard | foodflow_enterprise |
| `DB_CONNECTION_LIMIT` | 80 | 100 |
| `MERCHANT_CODE_PREFIX` | - | FF |
| `ALLOW_MERCHANT_REGISTRATION` | - | false |
| `MAX_STORES_PER_MERCHANT` | - | 0 |

### Nginx配置差异

| 配置项 | 标准版 | 企业版 |
|--------|--------|--------|
| upstream节点数 | 2台（固定） | 3台起（可扩展） |
| keepalive连接 | 64 | 128 |
| 超级管理员路径 | - | /super 单独配置 |
| HSTS头 | - | ✅ |
| SSL会话缓存 | 10m | 20m |

### Systemd配置差异

| 配置项 | 标准版 | 企业版 |
|--------|--------|--------|
| 文件描述符 | 65536 | 131072 |
| 进程数限制 | 4096 | 8192 |
| 内存限制 | 7G | 14G |
| 内存高水位 | 6G | 12G |

---

## 从标准版升级到企业版

1. 备份标准版数据库和上传文件
2. 部署企业版集群（参考企业版部署指南）
3. 迁移数据库到 foodflow_enterprise
4. 迁移上传文件到新的NFS共享存储
5. 配置企业版环境变量
6. 测试所有功能
7. 切换DNS到企业版集群
8. 下线标准版服务器

> **注意**：升级前请务必备份所有数据，并在测试环境验证升级流程。

---

## 技术支持

- 标准版部署问题：查看 `deploy/standard/README.md`
- 企业版部署问题：查看 `deploy/enterprise/README.md`
- 日志排查：`journalctl -u foodflow -f`
- Nginx日志：`tail -f /var/log/nginx/error.log`
