# 标准版部署指南（当前仓库）

> 本指南已按 Tony855/shaolafang 当前代码和安装器重写。旧版文档曾指向独立的 foodflow-standard 仓库及旧环境变量；不要再照旧命令部署。

## 推荐部署

~~~bash
git clone https://github.com/Tony855/shaolafang.git
cd shaolafang
sudo bash install.sh
~~~

首次运行默认执行**标准版单机最小安装**。完整步骤、数据库初始化、systemd、Nginx、HTTPS、首次凭据和故障排查见 [INSTALL.md](./INSTALL.md)。

## 标准版部署目录

- [标准版部署手册](./deploy/standard/README.md)
- [标准版环境变量模板](./deploy/standard/.env.example)
- [标准版部署脚本](./deploy/standard/deploy.sh)

当前模板使用 **DB_DATABASE=foodflow_standard**、**DB_USER=foodflow**、**DB_PASSWORD** 和 **JWT_SECRET**。请为数据库账号设置独立强密码；应用连接不得使用 MySQL root。单机 Redis 为可选项，默认不要求启用；定时任务默认关闭，确认单节点职责后再启用。

## 生产网络与权限

- 公网只开放 SSH、TCP 80 和 TCP 443。
- Node.js 端口 3000、MySQL 3306 和 Redis 6379 不应直接暴露公网。
- 应用服务使用非 root 的 foodflow 系统账号；上传、备份、日志目录按需授予写权限。
- 生产环境启用 HTTPS、异地备份，并定期演练恢复。

## 升级到集群

需要双应用节点时，使用 [企业版集群手册](./deploy/enterprise/README.md)；需要多商户水平扩展时，使用 [企业旗舰版手册](./deploy/enterprise-ultimate/README.md)。集群必须配置共享 Redis、NFS 上传目录和可信反向代理，不能直接复用单机配置。
