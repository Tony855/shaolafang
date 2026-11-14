# FoodFlow 安全与架构审查记录

**审查日期：** 2026-11-11  
**审查对象：** `Tony855/shaolafang`，默认分支 `main`  
**审查方式：** GitHub 源码、部署模板、CI 工作流及现有测试清单静态审查。  
**注意：** 本记录不是渗透测试或生产环境验收报告；未执行真实数据库迁移、线上部署或端到端攻击验证。

## 当前状态（2026-11-15）

以下状态优先于后文第 3、5、6 节中的历史“待处理”描述；旧章节保留作为审计轨迹。

| 历史发现 | 当前状态 | 核验边界 |
|---|---|---|
| 静态资源缓存策略冲突 | 已在 main 的三份 Nginx 模板修复 | 仍需生产浏览器缓存验收 |
| Nginx access log 记录 query string / Referer | 单机模板和安装器已修复；Enterprise/Enterprise Ultimate 集群模板已在 PR #268 增加 `foodflow_safe` 格式 | 必须以 PR #268 最新 head 的 CI 为准；历史日志仍需按保留策略清理 |
| Node 默认监听所有网卡 | main 已默认 loopback；集群通过显式 HOST 暴露私网监听 | 生产防火墙/安全组仍需现场检查 |
| 集群 TRUST_PROXY 与 Redis 共享状态 | PR #267 已合并；集群部署强制共享 Redis、可信代理 CIDR 和启动 readiness | 生产负载均衡器来源 IP、Redis 故障恢复仍需故障注入 |
| readiness 路由不一致 | main 已统一 `/health`，保留兼容别名并检查 MySQL；集群还检查 Redis/Socket.IO Adapter | 生产探针仍需实测 |
| Nginx 上传上限低于应用限制 | main 所有部署模板已统一 105M | 仍需在目标反向代理链路测试大文件上传 |
| 认证/上传错误日志暴露 | PR #268 已覆盖认证、KHQR、ZIP 导入/导出日志脱敏及回归测试 | 新增集群 Nginx 日志改动的 CI 尚待完成 |
| Telegram Bot Token 静态存储 | 当前 settings 表和备份保留 Bot Token 明文；API/UI 只做显示脱敏 | 已在 Telegram 运维文档明确披露；应用级加密、密钥轮换和旧值迁移仍是 P2 加固项 |
| Telegram 通知队列停用语义 | PR #266 增加全局 Bot、门店及单事件停用时的事务性 dead-letter 清理 | 最新 CI 尚待完成；真实 Telegram 双 Bot 和多门店验收未完成 |
| 大型单体路由/页面 | 仍是架构改进项，不是已确认可利用漏洞 | 应以小步拆分和集成测试推进 |

**当前 GitHub 状态：** PR #267 已合并；PR #266 和 #268 仍为 Draft。两项 PR 都必须以各自最新 head 的 CI/安装兼容性结果为准，不得沿用旧提交的通过状态。PR #266 还需要真实 Telegram staging、多门店隔离和备份恢复验收。

**分支保护：** 当前 GitHub API 未返回 main 的保护规则，仓库 Rulesets 列表为空。此项需要仓库管理员在 GitHub 设置中启用，不能由应用代码或本次 CI 自动替代。


## 1. 项目结构

- Node.js 26 / Express 4 后端，MySQL 8.4 与 MariaDB 10.11–12.3 纳入 CI 集成矩阵。
- 单机 Redis 可选；多节点集群通过 REQUIRE_SHARED_REDIS 强制共享 Redis，用于跨节点限流/冷却状态及 Socket.IO adapter。
- Socket.IO 实时事件。
- 原生 JavaScript 多页面前端：顾客、商户管理、服务员、后厨、收银、超级管理员。
- 业务路由位于 `routes/`，认证中间件位于 `server/middleware/`，数据库工具位于 `server/db/`，服务层位于 `server/services/`。
- 现有测试位于 `tests/`，CI 在 Node.js 26 环境执行语法检查、审计脚本、多语言校验、测试及生产依赖审计。

## 2. 本轮已修复

### [P1] Nginx 静态资源强缓存与应用缓存策略冲突

**证据：** 以下部署模板原先将 HTML、CSS、JS 和图片统一设置为 `expires 7d` 与 `Cache-Control: public, immutable`：

- `deploy/standard/nginx.conf`
- `deploy/enterprise/cluster/nginx.conf`
- `deploy/enterprise-ultimate/cluster/nginx.conf`

而 Express 页面路由及静态资源配置使用 `Cache-Control: no-cache, must-revalidate` / ETag 协商缓存；文件名并非全部内容哈希。代理层覆盖缓存头会使浏览器长期复用旧 HTML/JS/CSS，造成部署版本不一致。

**处理：** 在审查分支移除这三个模板中对代理静态资源的 7 天 immutable 覆盖，保留 Express 的缓存策略。上传图片目录继续使用独立长缓存策略。

## 3. 需要在部署或下一轮改进中处理



### [P1 - 凭据日志暴露] Nginx 默认 combined 日志会记录请求查询参数

**证据：** 顾客扫码入口仍兼容旧版 `?token=...` 桌台二维码参数。Nginx 默认 combined access log 使用完整请求行并记录 Referer；若沿用默认格式，旧版桌台 token 可能落入 `access.log`，而不是只存在于应用会话存储中。

**处理：** 单机安装器、Nginx 配置脚本和标准版模板改用 `foodflow_safe` 日志格式，只记录请求方法、规范化 URI（不含 query string）、协议、状态码和响应字节数；不记录 Referer。历史日志不会被追溯清理，需按日志保留策略评估并限制读取权限。

**验证：** 新增部署配置测试，断言这些入口使用安全日志格式且不记录 `$request`、`$request_uri`、`$args` 或 Referer。

### [P1 - 默认监听面] Node.js 后端原先监听所有 IPv4 接口

**证据：** 原始启动代码使用 `server.listen(PORT, '0.0.0.0')`，而单机 Nginx 模板反向代理到 `127.0.0.1:3000`。这使 Node 端口在所有网卡上监听；若云安全组或主机防火墙误开放该端口，外部请求可绕过 Nginx 的 TLS、访问控制及请求限制。

**处理：** 默认监听地址改为 `127.0.0.1`，新增 `HOST` 显式覆盖配置；单机安装器和单机模板使用 loopback，集群模板使用 `0.0.0.0` 并明确要求应用端口仅允许可信负载均衡器访问。生产现有防火墙和安全组仍需现场核验，代码默认值不能替代网络 ACL。

**验证：** 新增监听地址配置单元测试；CI 通过前不合并。集群部署须确认 HOST 与实际私网拓扑一致。

### [P1 - 部署条件] 多机 Nginx 反向代理的 TRUST_PROXY

应用默认设置 `TRUST_PROXY=loopback`，适用于 Nginx 与 Node 在同一主机的部署。企业集群模板的 Nginx 负载均衡器与应用节点是分离的；若部署时没有按实际网络拓扑显式配置可信代理，Express 可能只能看到负载均衡器地址，影响客户端 IP 识别、登录限流和审计日志。

**建议：** 集群部署时将 `TRUST_PROXY` 设置为实际负载均衡器内网 IP/CIDR 或严格限定的可信代理跳数；不要在不可信网络中直接设置为 `true`。防火墙应确保应用端口只接受负载均衡器来源。

### [P1 - 部署条件] 集群环境必须验证 Redis 可用性

应用在未配置 Redis 时会回退到进程内存缓存；这在单机可作为降级模式，但多应用节点的内存状态并不共享。集群部署文档已要求 Redis，但上线验收仍应验证所有节点使用同一个受保护的 Redis 服务，并验证 Redis 中断时限流、冷却和实时事件是否按预期 fail-closed 或降级。

**建议：** 对集群部署增加启动前配置检查；明确区分单机可选 Redis 与多节点必需 Redis。不要把内存 fallback 当作集群共享状态。

### [P1 - 健康检查路径] Nginx readiness 上游路径与 Node 路由不一致

**证据：** Node 实际提供 `/health`，但标准版及两个集群 Nginx 模板曾将 `/health` 转发至不存在的 `/api/health/ready`；健康巡检脚本还请求了 `/api/health` 和 `/api/health/ready`，造成探针与真实路由脱节。

**处理：** 统一以 `/health` 作为 canonical readiness 路径；Node 同时保留 `/api/health/ready` 与 `/api/health` 兼容别名，所有路径均执行数据库 `SELECT 1`，数据库不可用时返回 503。Nginx 模板和巡检脚本改为 `/health`。

### [P1 - 备份导入限制] Nginx 请求体上限低于应用备份解析上限

**证据：** `/api/super/backup/import` 的 Express JSON parser 允许 50 MB，但 Nginx 标准版/集群模板限制为 10 MB，单机安装脚本生成配置限制为 20 MB。较大的有效备份会在到达 Express 前被 Nginx 拒绝。

**处理：** 所有随仓库提供的 Nginx 模板及安装器生成配置统一设置为 105 MB，以容纳菜单接口允许的图片与视频双文件上传（每个文件最高 50 MB）以及 50 MB 备份 JSON，并为 multipart 开销留出余量。

### [P2 - 架构] 单体路由与大页面模块仍然偏大

`server.js`、`routes/admin-manage.js`、`routes/orders.js`、`pages/customer.js`、`pages/waiter.js` 等文件仍承载较多职责。当前已做模块拆分，但后续建议继续按业务域拆分订单状态机、支付/退款、门店隔离、打印任务和报表查询，并以服务接口和集成测试固定边界。

## 4. 安全审查重点

以下属于已核查的代码区域，不代表已证明完全安全：

- 管理员、超级管理员、收银员和服务员认证中间件。
- 会话 token 哈希存储及过期检查。
- 管理员门店选择与 merchant_id 约束。
- Socket.IO 连接认证与会话重验证。
- 订单金额计算、退款与结算并发保护。
- ZIP 菜单导入路径处理。
- 登录限流、扫描会话限流及 Redis 降级处理。
- 前端 HTML 转义与存储型 XSS 回归测试。

**注意事项：** 前端出现 `innerHTML` 本身不等于 XSS；必须逐个追踪数据来源和转义。类似地，代码搜索到 `Math.random()` 也不等于认证凭据可预测；需确认用途。不要将静态搜索命中直接记为已利用漏洞。

## 5. 本轮验证状态

- 已确认审查分支创建成功，未直接修改 `main`。
- Nginx 三份部署模板已提交缓存策略修复。
- GitHub Actions CI 已由该分支提交触发；当前正在执行，最终结果以 Actions 页面为准。
- 尚未宣称本地完整测试、生产依赖审计或线上验证通过。

## 6. 后续建议顺序

1. 等待 CI 完成；若失败，先修复失败项再创建/更新 PR。
2. 为集群部署增加 `TRUST_PROXY` 和 Redis 强制配置校验。
3. 已将 Nginx `/health` 转发到 Node 数据库 readiness，并保留旧健康检查 URL 兼容别名；仍需在生产部署后实测。
4. 为支付/退款、订单状态转换、跨商户/跨门店访问补充 API 集成测试。
5. 增加 Playwright 多端关键流程测试：扫码下单、厨房接单、收银结算、退款、权限拒绝。
6. 评估数据库迁移版本化、结构化日志、指标和告警；先保持兼容性，不做大规模一次性重写。


## 7. 跟进记录（2026-11-14）

### [P1 - 部署条件] 集群 Redis 与可信代理启动保护

**处理分支：** [PR #267](https://github.com/Tony855/shaolafang/pull/267)（已于 2026-11-14 合并，merge commit `d31d4dc`）。

- 新增 `REQUIRE_SHARED_REDIS=true` 启动保护；Redis URL 缺失、Redis 连接失败或 Socket.IO Redis Adapter 未就绪时，集群节点不会开始监听 HTTP。
- 集群模式要求显式 IP/CIDR 代理列表，拒绝默认 loopback、通配/全地址、主机名及无效 CIDR。
- 集群运行期间，`/health` 与 `/api/health/ready` 同时检查 MySQL、Redis 和 Socket.IO Redis Adapter；任一依赖断开时返回 503，恢复后自动恢复就绪；响应设置 `Cache-Control: no-store`。
- 两套企业集群模板启用该开关；部署脚本会在新建和已有 `/etc/foodflow/.env` 中强制写入 `REQUIRE_SHARED_REDIS=true`。
- 单机模板保持 `REQUIRE_SHARED_REDIS=false`，不改变单机 Redis 可选的降级行为。

**状态：** PR #267 的 CI/安装兼容性矩阵已通过并合并。尚未在生产集群执行故障注入；生产验收仍需验证 Redis 断开、恢复、Socket.IO 跨节点广播和真实负载均衡器 IP。

