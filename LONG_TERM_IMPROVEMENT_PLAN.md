# FoodFlow 长期架构升级方案

> 版本：v1.0 | 目标：从"快速原型"升级为"生产级多商户 SaaS 系统"

---

## 一、总体路线图

| 阶段 | 周期 | 目标 | 核心交付物 |
|------|------|------|-----------|
| **Phase 1：基础工程化** | 第 1-2 月 | 建立构建、测试、规范流程 | Vite 构建 + Jest 单测 + ESLint + 日志系统 |
| **Phase 2：数据与接口规范** | 第 3-4 月 | 统一字段、迁移、文档 | ORM/迁移工具 + Swagger API 文档 + 字段规范 |
| **Phase 3：多租户与高可用** | 第 5-6 月 | 支持多服务器、水平扩展 | Redis + 会话共享 + 数据库连接池优化 |

---

## 二、7 项长期改进详细方案

### 改进 1：引入构建工具（Vite）

**当前痛点：**
- `languages.min.js` 手工压缩，版本号手工维护（`?v=20260918`）
- 不同页面引用不同版本号，导致浏览器缓存不一致
- 多个 `<script>` 标签串行加载，首屏慢

**方案：**
```
技术选型：Vite 5.x（比 Webpack 启动快 10-100 倍）

目录结构调整：
foodflow/
├── src/
│   ├── pages/
│   │   ├── index.html      # 顾客端
│   │   ├── admin.html      # 商户后台
│   │   ├── waiter.html     # 服务员端
│   │   ├── kitchen.html    # 后厨端
│   │   ├── cashier.html    # 收银端
│   │   └── super.html      # 超管端
│   ├── assets/
│   │   ├── core.js         # 核心库
│   │   └── styles/
│   ├── i18n/
│   │   ├── zh.js
│   │   ├── en.js
│   │   ├── vi.js
│   │   ├── th.js
│   │   └── km.js
│   └── shared/             # 公共组件、工具函数
├── vite.config.js
└── package.json
```

**Vite 自动完成：**
1. `npm run build` 时自动把 `i18n/*.js` 打包压缩为 `languages.min.js`
2. 自动注入 hash 版本号（如 `languages-[hash].js`），彻底解决缓存问题
3. 自动 tree-shaking，移除未使用的代码
4. 开发时支持热更新（HMR），改代码实时刷新

**收益：**
- 翻译文件更新后自动生效，不需要手工改版本号
- 首屏加载时间减少 40-60%
- 代码结构清晰，不再有"哪个是最新版"的困惑

---

### 改进 2：引入测试框架（Jest + Supertest）

**当前痛点：**
- 29 个 P0 问题全靠手工点页面才发现
- 每次修改都怕"修一个坏两个"
- 边界情况（空值、损坏数据、并发）永远是盲区

**方案：**

```
技术选型：
- 单元测试：Jest
- API 测试：Supertest
- E2E 测试（可选）：Playwright

测试分层：
├── tests/
│   ├── unit/                    # 单元测试（纯函数）
│   │   ├── currency.test.js    # 货币换算
│   │   ├── i18n.test.js       # 翻译回退逻辑
│   │   ├── order.test.js       # 订单计算
│   │   └── sanitize.test.js    # 输入校验
│   ├── api/                    # API 集成测试
│   │   ├── auth.test.js         # 认证接口
│   │   ├── menu.test.js        # 菜品接口
│   │   ├── order.test.js       # 订单接口
│   │   └── permission.test.js  # 权限校验
│   └── i18n/                   # 翻译完整性测试
│       └── completeness.test.js
```

**测试覆盖要求：**
| 模块 | 覆盖率要求 | 重点测试场景 |
|------|-----------|-------------|
| 货币换算 | 100% | 正常/零/负数/极端汇率 |
| i18n 回退 | 90% | 缺 key/语言不存在/参数替换 |
| 订单计算 | 95% | 空 items/损坏 JSON/数量为 0 |
| 权限校验 | 100% | 跨店访问/未登录/权限位关闭 |
| 认证 | 95% | token 过期/伪造/并发登录 |

**翻译完整性测试示例：**
```javascript
test('所有语言 key 数量一致', () => {
  const langs = ['zh', 'en', 'vi', 'th', 'km'];
  const keySets = langs.map(l => new Set(Object.keys(LANG[l])));
  for (let i = 1; i < keySets.length; i++) {
    expect(keySets[i]).toEqual(keySets[0]);  // 多语言 key 完全对齐
  }
});
```

**收益：**
- 每次提交自动跑测试，回归 bug 减少 80%
- 敢重构了（改完跑测试就知道有没有坏）
- 边界情况自动覆盖，不用手工点

---

### 改进 3：统一 i18n 实现

**当前痛点：**
- 4 套 i18n 并存：SLF.i18n / WAITER_TEXT / ADMIN_LABELS / SUPER_LOCAL_I18N
- t() 函数签名不一致，有的支持参数替换，有的不支持
- 新增翻译要改 4-5 个地方

**方案：**

```
统一架构：
src/i18n/
├── index.js            # 唯一入口：SLF.i18n
├── zh.js               # 中文（基准语言）
├── en.js               # 英文
├── vi.js               # 越南语
├── th.js               # 泰语
└── km.js               # 高棉语

所有页面统一用法：
import { t } from './i18n';

// 1. 纯 key
t('orderTotal')          // → "订单总额"

// 2. 带参数
t('callCooldown', { minutes: 10 })   // → "呼叫过于频繁，请 10 分钟后再试"

// 3. 复数/回退（内置）
t('nonexistentKey')      // → 自动回退到英文，再回退到 key 本身
```

**删除清单：**
- ❌ waiter.html 中的 `WAITER_TEXT`
- ❌ admin.html 中的 `ADMIN_LABELS`
- ❌ super.html 中的 `SUPER_LOCAL_I18N`
- ❌ cashier.html 中的本地字典
- ❌ 所有 `tAdmin` / `L` 别名，统一用 `t`

**校验：**
- 构建时自动检查 5 种语言的 key 数量是否一致
- 缺 key 时构建直接报错，不允许上线

**收益：**
- 新增翻译只改 `i18n/xx.js` 一个地方
- 所有页面行为一致，不再有"服务员端正常，收银员端英文"
- 构建时自动发现漏翻译

---

### 改进 4：前后端字段命名规范

**当前痛点：**
- `session_token`（DB 下划线） vs `sessionToken`（JS 驼峰）
- `store_id` vs `storeId`
- `merchant_id` vs `merchantId`
- 转换散落各处，有的地方忘记转就出 undefined

**方案：**

```
统一规范：

数据库层（MySQL）：snake_case
┌─────────────────────┐
│ merchant_id         │
│ store_id            │
│ session_token       │
│ created_at          │
└─────────┬───────────┘
          │ ORM 自动转换
          ▼
API 层（JSON 输出）：camelCase
┌─────────────────────┐
│ merchantId          │
│ storeId             │
│ sessionToken        │
│ createdAt          │
└─────────┬───────────┘
          │ 前端直接用
          ▼
前端代码：camelCase
state.orders[0].sessionToken
```

**实施方式：**
1. 引入 ORM（如 Prisma），自动处理字段映射
2. 或者写一个统一的 `camelize()` 中间件，所有 API 响应自动转驼峰

```javascript
// 示例：Express 响应中间件
app.use((req, res, next) => {
  const originalJson = res.json;
  res.json = function(data) {
    return originalJson.call(this, camelizeKeys(data));  // 自动转驼峰
  };
  next();
});
```

**收益：**
- 前端永远只用 camelCase，不用记两套命名
- 后端永远只用 snake_case，符合 SQL 习惯
- 不再有"字段名写错导致 undefined"的 bug

---

### 改进 5：引入日志系统（Winston）

**当前痛点：**
- 全是 `console.log` / `console.warn` / `console.error`
- 生产环境日志满天飞，无法分级
- 出错后只能 `tail server.log`，没有结构化字段
- 无法远程上报，线上问题难定位

**方案：**

```
技术选型：Winston 3.x + DailyRotateFile

目录结构：
logs/
├── info/          # info 级日志（按天滚动）
│   ├── 2026-09-18.log
│   └── 2026-09-19.log
├── error/         # error 级日志（单独存）
│   └── 2026-09-18.log
└── combined.log   # 全量日志

日志格式（JSON 结构化）：
{
  "timestamp": "2026-09-18T12:34:56.789Z",
  "level": "error",
  "message": "订单支付失败",
  "orderId": 12345,
  "storeId": 5,
  "merchantId": 2,
  "userId": 789,
  "ip": "1.2.3.4",
  "error": {
    "code": "PAYMENT_FAILED",
    "message": "余额不足"
  }
}
```

**日志分级：**
| 级别 | 使用场景 | 输出位置 |
|------|---------|---------|
| error | 接口失败、数据库错误、未捕获异常 | 文件 + 告警 |
| warn | 权限拒绝、限流触发、降级处理 | 文件 |
| info | 登录、下单、支付等关键业务事件 | 文件 |
| debug | 调试信息（生产关闭） | 仅开发环境 |

**替换清单：**
- ❌ 所有 `console.log(...)` → `logger.info(...)`
- ❌ 所有 `console.warn(...)` → `logger.warn(...)`
- ❌ 所有 `console.error(...)` → `logger.error(...)`

**收益：**
- 线上出问题能快速查日志（按 orderId / storeId 过滤）
- 日志自动按天切割，不会撑爆磁盘
- 关键业务事件可追溯（谁在什么时间下了什么单）

---

### 改进 6：引入数据库迁移工具（Knex）

**当前痛点：**
- 手写 `ALTER TABLE` 散落在 `initDatabase()` 里
- 没有版本管理，不知道哪些迁移已经跑过
- 迁移中途重启会状态不一致
- 无法回滚

**方案：**

```
技术选型：Knex.js migration

目录结构：
migrations/
├── 20260901000000_init.js              # 初始建表
├── 20260905120000_add_merchant_id.js    # 添加 merchant_id
├── 20260910140000_add_permissions.js  # 添加管理员权限字段
├── 20260915100000_add_qr_langs.js      # 添加二维码语言字段
└── knex_migrations                    # 版本记录表（自动维护）

每个迁移文件包含 up() 和 down()：
exports.up = async (knex) => {
  await knex.schema.alterTable('menus', (table) => {
    table.integer('sales_count').defaultTo(0);
  });
};

exports.down = async (knex) => {
  await knex.schema.alterTable('menus', (table) => {
    table.dropColumn('sales_count');
  });
};
```

**命令：**
```bash
# 执行所有未跑过的迁移
npx knex migrate:latest

# 回滚上一次迁移
npx knex migrate:rollback

# 查看当前迁移状态
npx knex migrate:status
```

**收益：**
- 迁移有版本管理，跑过的不会再跑
- 出问题可以回滚
- 多人协作时，迁移文件纳入 git 管理，不会冲突

---

### 改进 7：引入 API 文档工具（Swagger / OpenAPI）

**当前痛点：**
- 100+ 个 API 接口，没有文档
- 前后端靠口头沟通，字段写错要互相问
- 新开发者上手慢

**方案：**

```
技术选型：Swagger (OpenAPI 3.0) + swagger-ui-express

使用方式：
1. 在路由上写 JSDoc 注释
2. 启动时自动生成 /api-docs 页面

示例：
/**
 * @swagger
 * /api/orders:
 *   post:
 *     summary: 创建订单
 *     tags: [订单]
 *     security:
 *       - WaiterToken: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tableName
 *               - items
 *             properties:
 *               tableName:
 *                 type: string
 *                 example: "A01"
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: integer
 *                     quantity:
 *                       type: integer
 *     responses:
 *       200:
 *         description: 创建成功
 *       403:
 *         description: 无权限
 */
app.post('/api/orders', requireAdminOrWaiter, async (req, res) => { ... });
```

**访问地址：**
```
https://foodflow.v2net.cc/api-docs
```

**收益：**
- 前端开发者直接看文档，不用问后端
- 可以在线调试接口（Swagger UI 自带 Try it out）
- 接口变更自动同步，文档永远最新

---

## 三、实施优先级

| 优先级 | 改进项 | 预计工时 | 收益 |
|--------|--------|---------|------|
| P0 | 统一 i18n 实现 | 3 天 | 解决 30% 的用户反馈 |
| P0 | 字段命名统一 | 2 天 | 减少 50% 的 undefined bug |
| P1 | 引入日志系统 | 2 天 | 线上问题可追溯 |
| P1 | 引入迁移工具 | 3 天 | 数据库变更可控 |
| P2 | 引入构建工具 | 5 天 | 加载快 + 无缓存问题 |
| P2 | 引入测试框架 | 10 天 | 回归 bug 减少 80% |
| P3 | 引入 API 文档 | 5 天 | 前后端协作顺畅 |

**总工时：约 30 个工作日（6 周）**

---

## 四、风险与注意事项

1. **不要一次性全部改完**：按优先级分批，每改完一批上线验证
2. **保持向后兼容**：旧 API 保留，新接口并行，慢慢迁移
3. **先写测试再重构**：没有测试的重构等于赌博
4. **数据库迁移一定要备份**：生产环境跑迁移前先 mysqldump

---

## 五、完成标志

- [ ] 所有页面统一用 `SLF.i18n.t()`
- [ ] 所有 API 输出 camelCase
- [ ] 所有日志走 Winston，按天切割
- [ ] 所有数据库变更走 Knex migration
- [ ] `npm run build` 一条命令完成所有打包
- [ ] `npm test` 覆盖核心业务逻辑，覆盖率 > 80%
- [ ] `/api-docs` 可访问，文档与代码同步

---

**从"能跑"到"生产级"，需要的是工程化能力，而不只是写功能。**
