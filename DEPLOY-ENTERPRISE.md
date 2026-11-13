# 企业版与集群部署指南（当前仓库）

> 本指南已按 Tony855/shaolafang 当前仓库结构重写。旧版内容包含不再随本仓库提供的 Kubernetes 清单、旧数据库变量和独立仓库克隆命令；不要再使用那些历史命令。

## 选择部署拓扑

| 拓扑 | 适用场景 | 当前部署手册 |
|---|---|---|
| 双应用节点企业版 | 单品牌/连锁业务，需要应用层冗余 | [deploy/enterprise/README.md](./deploy/enterprise/README.md) |
| 多节点企业旗舰版 | 多商户 SaaS、水平扩展 | [deploy/enterprise-ultimate/README.md](./deploy/enterprise-ultimate/README.md) |

## 获取当前仓库

~~~bash
git clone https://github.com/Tony855/shaolafang.git
cd shaolafang
~~~

安装器的集群入口：

~~~bash
sudo bash install.sh enterprise master
sudo bash install.sh enterprise-ultimate master
~~~

先阅读对应部署手册，再运行安装命令。所有应用节点必须使用相同的数据库、Redis、可信代理和共享上传配置。

## 生产配置要求

- 使用模板 deploy/enterprise/cluster/.env.example 或 deploy/enterprise-ultimate/cluster/.env.example。
- 应用数据库账号为专用的 foodflow 用户；数据库名分别使用模板中的 foodflow_enterprise 或 foodflow_enterprise_ultimate。禁止应用使用 MySQL root。
- 多节点必须配置共享 REDIS_URL，不能回退到进程内存状态。
- TRUST_PROXY 必须设置为真实 Nginx/负载均衡器内网 IP 或 CIDR。
- 所有应用节点必须将 /mnt/shared/uploads 挂载为可写的 NFS/NFSv4 文件系统；www-data UID/GID 必须与 NFS 服务端保持一致（默认 33:33）。部署脚本会执行挂载类型和写权限检查。
- NFS 导出必须使用 root_squash，上传目录权限不得设置为 world-writable。
- 仅向公网开放 SSH、80 和 443；数据库、Redis、NFS 和 Node.js 端口只允许受信任内网访问。

## 当前支持边界

本仓库提供 systemd、Nginx、MySQL、Redis 和 NFS 集群部署脚本及文档；**不包含旧版文档中提到的 Kubernetes、RabbitMQ、Prometheus/Grafana 部署清单**。如需 Kubernetes 生产部署，应先单独完成容器化、探针、持久化、Secret 管理和故障恢复验收，不要直接套用旧版 kubectl apply 示例。
