# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/) 规范。
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 2026-09-29 全面重构

#### Added 新增
- `server/middleware/password.js`：独立的密码哈希模块
- `server/middleware/admin-auth.js`：管理员认证中间件（7 个函数）
- `CHANGELOG.md`（本文件）
- `scripts/health-check.sh`：部署后一键健康巡检

#### Changed 变更
- **前端资源**
  - 6 个页面的内联 `<style>` 全部外置到 `assets/*.css`
  - `login.html` 的 274 行内联 JS 外置到 `pages/login.js`
  - Font Awesome 从 CDN 改为本地 `assets/vendor/fontawesome/`
  - 移除 Noto Sans SC 外网字体依赖

- **国际化（i18n）**
  - 删除 267 个未被引用的死 key（5 语言同步）
  - 补齐 16 个代码使用但 locale 缺失的 key
  - 补齐 15 个 UI 硬编码中文的新 key
  - 补齐 vi/th/km 的 53 个未翻译 key
  - `check-lang.js` 支持 `--check-dup` 参数查看跨语言雷同
  - 品牌词/技术术语白名单

- **代码统一**
  - `esc()` 从 5 份实现合并到 `core.js` 的 `global.esc`
  - `t()` 从 7 份实现合并到 `core.js` 的 `SLF.t`
  - `admin/context.js` 的 `esc` / `tAdmin` 改为引用全局

- **多租户隔离**
  - 19 处业务表 INSERT 补齐 `merchant_id` 字段
  - `ensureOrderTables` 修复 JOIN 缺 `store_id` 条件
  - 新增 `merchant_id` 字段的历史数据修正

- **前端逻辑**
  - `pages/admin.js` / `pages/admin/*.js` 14 个模块化文件
  - `pages/login.js` 独立文件
  - 删除 78 个临时调试脚本

#### Fixed 修复
- **P0**：admin 登录错误密码返回 500（`routes/auth.js` 的 `recordLoginAttempt` 拼写错误）
- **P0**：`pages/cashier.js` 语法错误导致整页脚本失效
- **P0**：`pages/admin/printer.js` 引用未定义函数 `toggleAutoPrint` 导致报错
- **P1**：8 个 HTML 内联 `onclick` 调用的函数未挂载到 `window`
- **P1**：`pages/cashier.js` 切换语言无响应（`window.changeLang` 未挂载）
- **P1**：`POST /api/admin/waiters` 500（`hashPassword is not defined`）
- **P1**：`changeLang` 未 `await` `SLF.i18n.init`，快速切换语言时显示旧文本

#### Removed 删除
- `server/middleware/auth.js` 中 300 行冗余代码（只保留 `requireSuperAdmin` / `requireCashier`）
- `server.js` 中 580 行重复定义（改为从模块引入）
- 267 个未引用 i18n key
- 78 个临时调试脚本

#### Security 安全
- 商户级数据隔离：所有业务表 INSERT 补齐 `merchant_id`
- 店铺级数据隔离：认证层验证 `X-Store-Id` 归属
- 双商户隔离测试脚本：13 项攻击测试全部通过

## 更早版本

（略）
