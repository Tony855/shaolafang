# FoodFlow 全面重构报告

**日期**：2026-09-29
**范围**：前端资源、i18n、后端模块化、多租户隔离、代码质量

---

## 一、成果概览

| 维度 | 改进前 | 改进后 | 变化 |
|---|---|---|---|
| `server.js` 行数 | 1363 | 1170 | -14% |
| `languages.min.js` | 216 KB | 168 KB | -22% |
| i18n key 数 | 882 | 673 | -24% |
| CSS 文件 | 11 个 | 10 个 | -1 |
| 重复 `esc()` | 5 份 | 1 份 | -80% |
| 重复 `t()` | 7 份 | 1 份 | -86% |
| 未挂 window 的 IIFE 函数 | 8 | 0 | -100% |
| 无 merchant_id 的 INSERT | 19 处 | 0 处 | -100% |

---

## 二、详细改动

### 2.1 前端资源

- CSS 抽取：6 页面的 `<style>` 全部外置
- JS 抽取：`login.html` 274 行 → `pages/login.js`
- CDN 本地化：Font Awesome 转到 `assets/vendor/fontawesome/`
- 移除外网字体：Noto Sans SC
- CSS 合并：`admin-page.css`（74 选择器）→ `admin.css`

### 2.2 国际化（i18n）

- 删除死 key：267 个（5 语言同步）
- 补缺失 key：16 个
- 补 vi/th/km 未翻译：38 + 53 个
- 补 JS toast：21 处
- 补 HTML placeholder：34 处
- 补 select option：36 处
- 补弹窗按钮/标题：10 处
- `check-lang.js` 加 `--check-dup` + 品牌词白名单

### 2.3 后端模块化

- 新建 `server/middleware/password.js`
- 新建 `server/middleware/admin-auth.js`
- 精简 `server/middleware/auth.js`（300 → 58 行）
- `server.js` 瘦身：从模块 import
  - `server/services/geo.js`
  - `server/services/backup.js`
  - `server/services/order.js`
  - `server/services/orderNo.js`
  - `server/services/printer.js`

### 2.4 代码质量

- `esc()` 统一：5 份 → 1 份（core.js）
- `t()` 统一：7 份 → 1 份（SLF.t，带 fallback）
- 8 个 IIFE 内部函数挂到 window（onclick 修复）

### 2.5 多租户隔离

- 19 处业务表 INSERT 补齐 `merchant_id`
- 修复 `ensureOrderTables` 的 JOIN 缺 store_id
- 双商户攻击测试 13/13 通过，9 表 0 错误

---

## 三、关键 Bug 修复

| 优先级 | 问题 | 影响 | 修复 |
|---|---|---|---|
| P0 | `routes/auth.js` 引用未定义的 `recordLoginAttempts` | admin 登录错误密码 500 | 改为单数 |
| P0 | `pages/cashier.js` 语法错误 | 整页脚本失效 | 修复 `});` |
| P0 | `pages/admin/printer.js` 引用未定义的 `toggleAutoPrint` | Console 报错 | 改挂到 admin.js |
| P1 | 8 个 onclick 函数未挂 window | 功能失效 | 挂到 window |
| P1 | `POST /api/admin/waiters` 500 | 无法创建服务员 | 加 hashPassword require |
| P1 | `changeLang` 未 await init | 切语言显示旧文本 | 加 async/await |
| P2 | cashier pageTitle 缺空格 | en 显示 `CashierOrder List` | 加 `·` 分隔 |

---

## 四、验证结果

- 健康巡检：24/0 通过
- 多租户隔离：13/13 通过
- i18n 一致：5 语言 673 key 全对齐
- 全站语法：全部通过

---

## 五、后续建议

| 优先 | 任务 |
|---|---|
| 高 | super.html 硬编码 i18n 化（约 115 处） |
| 高 | 275 个新 key 的 vi/th/km 翻译（建议当地人校对） |
| 中 | 观察 1 周后清理 `*.bak-*` 备份 |
| 中 | Nginx 静态资源配置 |
| 低 | 添加 E2E 测试 |
