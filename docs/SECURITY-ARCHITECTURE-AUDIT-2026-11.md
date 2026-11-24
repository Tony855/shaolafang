**审查日期：** 2026-11-24
**审查对象：** `Tony855/shaolafang`，`main` 当前 SHA `c5fbde95582027b998762fc99cdb4dff1534be52`。
**审查方式：** GitHub 源码、部署模板、迁移机制、测试/CI、Actions artifacts、PR/issue/branch 状态交叉核验。
**注意：** 本记录不是渗透测试或生产环境验收报告；未执行真实数据库迁移、线上部署、真实支付、Telegram 投递或打印机现场测试。

## 当前状态（2026-11-24）

本节是当前状态的唯一权威快照；后文第 2–8 节保留历史审计轨迹，若其中“待处理”“Draft”或旧 SHA 与本节冲突，以本节为准。

| 领域/发现 | 当前状态 | 核验边界 |
|---|---|---|
| 静态资源缓存策略 | main 已修复三份标准/企业/旗舰 Nginx 模板的缓存头冲突 | 生产浏览器缓存仍需现场验收 |
| Nginx access log 泄露 query/Referer | 根目录配置、安装器生成配置、标准/企业/旗舰模板均使用 `foodflow_safe`；日志不包含 query 或 Referer，回归测试覆盖 | 历史日志清理、生产 reload 后抽查未验证 |
| Nginx 上传上限 | 所有仓库模板/安装器生成配置为 105M；部署配置测试检查该值 | 外层 CDN/WAF/云负载均衡器限制未验证 |
| Node 监听面 | main 默认 loopback；集群显式配置私网监听 | 生产防火墙、安全组和真实拓扑未验证 |
| 集群 TRUST_PROXY / Redis / Socket.IO | 代码、部署模板和 readiness 检查已实现；CI/安装矩阵通过 | 多节点故障注入、真实 LB IP、Redis 故障恢复未验证 |
| 数据库 readiness | `/health` 为 canonical，兼容旧别名；集群检查 MySQL/Redis/Socket.IO Adapter | 生产探针未验证 |
| 认证/订单/打印日志脱敏 | PR #268/#269/#270 已合并，main 有对应回归测试 | 生产日志抽查与事件响应演练未验证 |
| 路由 5xx 原始错误泄露 | [PR #319](https://github.com/Tony855/shaolafang/pull/319) 已覆盖共享错误归一化、菜单逐行导入和 Telegram 测试错误脱敏；最终 head `ecaf8346acae053f1979afbd65dbbd01e15ef1b3` 的 17/17 检查通过 | PR 仍 open、未合并；main 仍保留旧 handler，必须由所有者审查并合并后才算修复上线 |
| 安装器 GitHub Token URL 泄露 | main 仍含 token-bearing clone/pull URL；当前修复 PR [#334](https://github.com/Tony855/shaolafang/pull/334) 基于 main `c5fbde9`，改用临时 0700 GIT_ASKPASS，token 不进入 Git URL/参数；安装兼容性 5/5 已通过 | PR #334 的 CI 与 Full System Audit 尚在运行，未合并；旧 PR #320 已落后当前 main，不作为当前版本验收依据 |
| Telegram Bot Token 静态存储 | settings 表和备份仍保留 Bot Token 明文；API/UI 脱敏不等于静态加密 | 应用级加密、密钥轮换、旧值迁移需要独立密钥管理方案；Issue #265 保持 open |
| Telegram 通知 outbox | [PR #266](https://github.com/Tony855/shaolafang/pull/266) 已合并，merge commit `35ba63e29f7d731586c60259e50e0031754bc9e7`；worker 默认关闭 | Issue #265 的真实双 Bot、多门店、撤销、重启/租约和备份恢复验收未完成 |
| main 分支保护 | main 实际返回 `protected=false`，仓库 Rulesets 为 `[]` | Issue #224 保持 open；当前 GitHub 集成没有保护规则写入能力，需仓库管理员设置 |
| 多语言 | 五种 locale 均为 1,348 keys，0 missing/extra；HTML integrity 0 | Issue #306 的 339 HTML、1,712 authored JS、681 route-message 项是原始扫描候选，不是确认缺陷 |
| 重复函数/单体模块 | 静态审计发现若干同名函数和较大路由/页面模块 | 命中需逐项语义比对；不以函数同名直接判定重复实现或自动重构 |

### 精确 SHA 与 CI 证据

- 当前 main：`c5fbde95582027b998762fc99cdb4dff1534be52`（PR #333 合并提交）。CI [#45317558941](https://github.com/Tony855/shaolafang/actions/runs/45317558941)、Full System Audit [#45317558845](https://github.com/Tony855/shaolafang/actions/runs/45317558845)、Installer Compatibility [#45317558788](https://github.com/Tony855/shaolafang/actions/runs/45317558788) 均成功；安装兼容性 Debian 12/13、Ubuntu 22.04/24.04/26.04 为 5/5。
- PR #319：历史 head `ecaf8346acae053f1979afbd65dbbd01e15ef1b3` 的 CI/审计/安装矩阵曾全部成功；但该 PR 当前仍 open 且基于旧 main，需同步到 `c5fbde9` 后重新验证，旧检查不作为当前基线验收。
- PR #334：head `251f646ea6ff528a8d5ef0396b61ac1eb90858d5`，基于当前 main；Installer Compatibility [#45318691102](https://github.com/Tony855/shaolafang/actions/runs/45318691102) 已通过 5/5。CI [#45318691161](https://github.com/Tony855/shaolafang/actions/runs/45318691161) 与 Full System Audit [#45318691027](https://github.com/Tony855/shaolafang/actions/runs/45318691027) 检查时仍在运行，尚不能宣称通过。
- PR #319/#320 均未合并；#319 需要更新，#320 的当前-main 后续由 #334 承接。main 当前无分支保护，因此合并前必须由仓库所有者完成代码审查并配置保护规则。

### 当前待处理 issue

- [Issue #224](https://github.com/Tony855/shaolafang/issues/224)：main 分支保护尚未启用。
- [Issue #265](https://github.com/Tony855/shaolafang/issues/265)：Telegram 真实 staging 验收及 Bot Token 静态加密/轮换。
- [Issue #306](https://github.com/Tony855/shaolafang/issues/306)：全仓库 i18n 候选项分类与逐模块修复。

### 2026-11-24 增量核验

- PR [#333](https://github.com/Tony855/shaolafang/pull/333) 已合并，安装器仓库来源路径与部署文档修正进入 main；精确 main 的 CI、完整审计及五平台安装兼容性全部通过。
- PR #334 的安装兼容性已通过五个平台；CI 与完整系统审计仍在运行。当前 main 的 Token URL 风险尚未因 PR 创建而消除，必须等待修复通过审查并合并后才算解决。
- 本轮未执行生产部署、真实数据库变更、线上支付或外部渗透测试。

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



## 8. 跟进记录（2026-11-15）

### [P1 - 错误日志信息泄露] 认证、上传/导入错误脱敏

**处理分支：** [PR #268](https://github.com/Tony855/shaolafang/pull/268)，已于 2026-11-14 合并至 main，merge commit `c8cc929404e6a6c4b1ada99642bc4fd2c237c4b5`。

- 认证存储故障统一返回通用 503，不再把数据库驱动异常作为认证失败或原始错误回传。
- Socket.IO、管理员登录、审计日志、KHQR、菜单 ZIP 导入/导出日志仅记录安全元数据；ZIP 行级错误对客户端使用通用描述。
- 两套企业集群 Nginx 模板对 HTTP/HTTPS 均采用不记录 query string/Referer 的 `foodflow_safe` 格式。
- QR 图片无法解析、payload 不支持被分类为 400，Jimp API 不兼容仍保留内部错误分类。
- PR #268 的 CI 与 Installer Compatibility 工作流均通过；CI 覆盖验证、MySQL 8.4、MariaDB 10.11/11.4/11.8/12.3，安装器覆盖 Debian 12/13、Ubuntu 22.04/24.04/26.04。

**生产边界：** 需要在实际 Nginx reload 后抽查 access log，确认历史日志按保留策略处理；CI 不代表生产节点已经应用配置。

### [P1 - Telegram 通知] main 同步及重新验证

PR #266 已同步 PR #268 合并后的 main，最新 head 为 `0c83adc7d9c615d51c7e86980e0e8318629b90b2`。同步后的最新 head `0c83adc7d9c615d51c7e86980e0e8318629b90b2` 的 CI 与安装兼容性矩阵均已通过。

**尚未完成：** 真实 Client/Admin Bot 投递、跨门店 Chat ID 隔离、QR 重扫重绑、备份恢复后绑定失效/重新绑定、worker 重启与租约恢复 soak、部署 webhook secret 与 worker flag 的现场核验。生产 worker 必须保持关闭，直至验收通过。


### [P1 - 残余日志数据泄露] QR 打印异常与订单明细

**处理分支：** [PR #269](https://github.com/Tony855/shaolafang/pull/269)，已于 2026-11-15 合并至 main，merge commit `30663837cb7fdc62f1247fcc1ebf8eaa98148e77`。

- QR 打印异常日志改用 `safeErrorMetadata`，不再记录原始异常消息/堆栈。
- 订单 items JSON 解析失败时不再把原始订单明细写入日志（其中可能包含顾客电话、备注和商品信息）；只记录有限的订单编号。
- 将订单服务的 DB helper 改为按需加载，避免纯格式化逻辑在测试/工具导入时触发数据库配置退出；同时修复旧密码重哈希路径缺少 `runAsync` 引用的问题。
- 最新 head `20e619ae80cbcd6565bbc3dfda23b1dd62471aad` 的 validate、MySQL 8.4、MariaDB 10.11/11.4/11.8/12.3 和五个安装目标全部通过。


### [P1 - 订单路由/打印日志] 内部异常信息与打印机标识

**处理分支：** [PR #270](https://github.com/Tony855/shaolafang/pull/270)，已于 2026-11-15 合并至 main，merge commit `db703d39730032d2d68f808d3b0d5fdc445b1de8`。

- 订单创建、更新、菜品状态切换、订单号冲突和自动打印错误日志统一使用 `safeErrorMetadata`。
- 成功打印日志不再输出打印机标识/地址。
- 新增回归测试，确保模拟数据库错误消息中的密码不会进入订单创建日志。
- 最新 head `87e15838cbf00502c6ace3bed112a965e91f9698` 的 validate、MySQL 8.4、MariaDB 10.11/11.4/11.8/12.3 与五个安装目标全部通过。


### [P1 - Telegram 分支同步] 合并前的最新验证

2026-11-15，PR #266 分支已把 PR #269 与 #270 的日志修复及回归测试同步进来：QR 打印错误日志脱敏、订单 items 解析错误不再输出原始顾客数据、订单路由和打印机日志使用安全元数据。最新 head 为 `a6f82ceea063de42cfbdcd73896204b34a5bec4d`。

- CI：validate、MySQL 8.4、MariaDB 10.11/11.4/11.8/12.3 全部通过。
- Installer Compatibility：Debian 12/13、Ubuntu 22.04/24.04/26.04 全部通过。
- GitHub compare：322 commits ahead、4 behind，mergeable clean。
- 仍未完成：真实 Client/Admin Bot 投递、多门店隔离、撤销/停用竞态的现场回归、备份恢复后绑定生命周期、worker 重启/租约恢复 soak。保持 PR Draft，不做生产启用。
