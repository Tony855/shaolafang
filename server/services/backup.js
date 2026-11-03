/* ============================================================
   server/services/backup.js — 自动备份 + 日志清理
   ============================================================ */
const path = require('path');
const fs = require('fs');
const { runAsync, getAsync, allAsync } = require('../db/helpers');

async function collectBackupData() {
  const tables = ['menus', 'tables', 'orders', 'order_sequences', 'currencies', 'menu_categories', 'settings', 'login_logs', 'audit_logs', 'waiters', 'stores', 'waiter_calls', 'reservations', 'printers', 'merchants', 'merchant_admins', 'super_admins'];
  const data = { exportedAt: new Date().toISOString(), tables: {} };
  for (const table of tables) {
    data.tables[table] = await allAsync(`SELECT * FROM \`${table}\``);
  }
  return data;
}

async function autoBackupDatabase() {
  const backupDir = path.join(__dirname, '..', '..', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const data = await collectBackupData();
  const filename = path.join(backupDir, `auto-${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(filename, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
  await runAsync("INSERT INTO settings (`key`, value) VALUES ('last_backup_at', ?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [new Date().toISOString()]);
}

async function maybeAutoBackup() {
  const intervalRow = await getAsync("SELECT value FROM settings WHERE `key` = 'backup_interval_hours'");
  const intervalHours = Number(intervalRow?.value || 24);
  const lastRow = await getAsync("SELECT value FROM settings WHERE `key` = 'last_backup_at'");
  const lastTime = lastRow ? new Date(lastRow.value).getTime() : 0;
  if (Date.now() - lastTime >= intervalHours * 60 * 60 * 1000) {
    await autoBackupDatabase();
  }
}

async function autoCleanLogs() {
  try {
    const enabledRow = await getAsync("SELECT value FROM settings WHERE `key` = 'auto_clean_log_enabled'");
    if (!enabledRow || (enabledRow.value !== '1' && enabledRow.value !== 'true')) return;
    const daysRow = await getAsync("SELECT value FROM settings WHERE `key` = 'log_retention_days'");
    const retentionDays = parseInt(daysRow?.value || '30', 10);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const cleanLoginRow = await getAsync("SELECT value FROM settings WHERE `key` = 'clean_login_log'");
    const cleanAuditRow = await getAsync("SELECT value FROM settings WHERE `key` = 'clean_audit_log'");
    let cleaned = 0;
    if (!cleanLoginRow || cleanLoginRow.value === '1' || cleanLoginRow.value === 'true') {
      try {
        const result = await runAsync('DELETE FROM login_logs WHERE createdAt < ?', [cutoff]);
        cleaned += result.affectedRows || 0;
      } catch (e) { console.warn('清理登录日志失败:', e.message); }
    }
    if (!cleanAuditRow || cleanAuditRow.value === '1' || cleanAuditRow.value === 'true') {
      try {
        const result = await runAsync('DELETE FROM audit_logs WHERE created_at < ?', [cutoff]);
        cleaned += result.affectedRows || 0;
      } catch (e) { console.warn('清理审计日志失败:', e.message); }
    }
    if (cleaned > 0) {
      console.log(`🧹 自动清理日志: 删除 ${cleaned} 条过期日志（保留 ${retentionDays} 天）`);
    }
  } catch (e) {
    console.warn('自动清理日志失败:', e.message);
  }
}

module.exports = { collectBackupData, autoBackupDatabase, maybeAutoBackup, autoCleanLogs };
