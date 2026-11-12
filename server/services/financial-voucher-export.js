'use strict';

const MAX_EXPORT_ROWS = 5000;
const MAX_RANGE_DAYS = 31;

function positiveId(value, field) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(field + ' must be a positive safe integer');
  }
  return number;
}

function parseDate(value, field) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { text, date };
}

function normalizeExportRange(from, to) {
  const start = parseDate(from, 'from');
  const end = parseDate(to, 'to');
  if (!start || !end) {
    const error = new TypeError('from and to must be valid YYYY-MM-DD dates');
    error.code = 'VOUCHER_EXPORT_DATE_RANGE_INVALID';
    throw error;
  }
  const days = Math.floor((end.date.getTime() - start.date.getTime()) / 86400000) + 1;
  if (days < 1 || days > MAX_RANGE_DAYS) {
    const error = new RangeError('export range must contain between 1 and 31 days');
    error.code = 'VOUCHER_EXPORT_DATE_RANGE_INVALID';
    throw error;
  }
  const nextDay = new Date(end.date.getTime() + 86400000).toISOString().slice(0, 10);
  return Object.freeze({ from: start.text, to: end.text, startAt: start.text + ' 00:00:00', endExclusive: nextDay + ' 00:00:00' });
}

function csvCell(value, numeric = false) {
  let text = value === null || value === undefined ? '' : String(value);
  if (!numeric && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

const COLUMNS = Object.freeze([
  ['journalTransactionId', 'Journal transaction ID', true],
  ['createdAt', 'Created at', false],
  ['currencyCode', 'Currency code', false],
  ['sourceType', 'Source type', false],
  ['sourceId', 'Source ID', false],
  ['description', 'Description', false],
  ['createdBy', 'Created by', false],
  ['lineNo', 'Line number', true],
  ['accountCode', 'Account code', false],
  ['direction', 'Direction', false],
  ['amountMinor', 'Amount (minor units)', true],
  ['memo', 'Line memo', false]
]);

function buildJournalCsv(rows) {
  const header = COLUMNS.map(([, label]) => csvCell(label)).join(',');
  const lines = rows.map(row => COLUMNS.map(([key, , numeric]) => csvCell(row[key], numeric)).join(','));
  return '\uFEFF' + [header, ...lines].join('\r\n') + '\r\n';
}

function createFinancialVoucherExportService({ allAsync, withTransaction }) {
  if (typeof allAsync !== 'function' || typeof withTransaction !== 'function') {
    throw new TypeError('allAsync and withTransaction dependencies are required');
  }

  async function exportJournalDetails(input) {
    const merchantId = positiveId(input.merchantId, 'merchantId');
    const storeId = positiveId(input.storeId, 'storeId');
    const range = normalizeExportRange(input.from, input.to);
    return withTransaction(async () => {
      const rows = await allAsync(
        `SELECT j.id AS journalTransactionId, j.created_at AS createdAt,
                j.currency_code AS currencyCode, j.source_type AS sourceType,
                j.source_id AS sourceId, j.description, j.created_by AS createdBy,
                e.line_no AS lineNo, e.account_code AS accountCode,
                e.direction, e.amount_minor AS amountMinor, e.memo
         FROM financial_journal_transactions j
         INNER JOIN financial_journal_entries e
           ON e.transaction_id=j.id
          AND e.merchant_id=j.merchant_id
          AND e.store_id=j.store_id
         WHERE j.merchant_id=? AND j.store_id=?
           AND e.merchant_id=? AND e.store_id=?
           AND j.created_at>=? AND j.created_at<?
         ORDER BY j.created_at ASC, j.id ASC, e.line_no ASC
         LIMIT ?`,
        [merchantId, storeId, merchantId, storeId, range.startAt, range.endExclusive, MAX_EXPORT_ROWS + 1]
      );
      if (rows.length > MAX_EXPORT_ROWS) {
        const error = new RangeError('journal export exceeds the maximum row count');
        error.code = 'VOUCHER_EXPORT_TOO_LARGE';
        throw error;
      }
      return Object.freeze({
        from: range.from,
        to: range.to,
        rowCount: rows.length,
        csv: buildJournalCsv(rows)
      });
    });
  }

  return Object.freeze({ exportJournalDetails });
}

module.exports = {
  MAX_EXPORT_ROWS,
  MAX_RANGE_DAYS,
  normalizeExportRange,
  csvCell,
  buildJournalCsv,
  createFinancialVoucherExportService
};
