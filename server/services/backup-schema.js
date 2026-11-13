'use strict';

// Parent tables must precede dependent tables during restore. The reverse order
// is used for deletion so InnoDB foreign keys remain enabled throughout restore.
const FINANCIAL_BACKUP_TABLES = Object.freeze([
  'financial_journal_transactions',
  'financial_journal_entries',
  'financial_reconciliation_batches',
  'financial_reconciliation_items',
  'financial_reconciliation_review_events',
  'financial_reconciliation_exception_cases',
  'financial_reconciliation_exception_events',
  'financial_reconciliation_exception_alerts',
  'financial_reconciliation_exception_alert_events',
  'financial_month_close_periods',
  'financial_month_close_events',
  'provider_webhook_events'
]);

const BACKUP_TABLES = Object.freeze([
  'merchants',
  'stores',
  'tables',
  'menu_categories',
  'menus',
  'currencies',
  'order_sequences',
  'orders',
  'refund_requests',
  ...FINANCIAL_BACKUP_TABLES,
  'settings',
  'login_logs',
  'audit_logs',
  'waiters',
  'waiter_calls',
  'reservations',
  'printers',
  'merchant_admins',
  'super_admins'
]);

const LEGACY_OPTIONAL_BACKUP_TABLES = Object.freeze([
  'order_sequences',
  'refund_requests',
  ...FINANCIAL_BACKUP_TABLES
]);

module.exports = { BACKUP_TABLES, FINANCIAL_BACKUP_TABLES, LEGACY_OPTIONAL_BACKUP_TABLES };
