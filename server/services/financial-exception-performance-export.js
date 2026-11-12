'use strict';

const COLUMNS = ['group','currencyCode','name','activeCount','overdueActiveCount','overdueRatePercent','resolvedEventCount','onTimeResolvedEventCount','onTimeResolutionRatePercent','avgImportToResolveSeconds'];
function csvCell(value) {
  let text = String(value === null || value === undefined ? '' : value);
  if (/^[\\s\\u0000-\\u001f]*[=+@\\-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
function buildExceptionPerformanceCsv(summary) {
  const source = summary || {}, rows = [];
  (Array.isArray(source.byCurrency) ? source.byCurrency : []).forEach(row => rows.push({ group:'currency', currencyCode:row.currencyCode, name:'', ...row }));
  (Array.isArray(source.byAssignee) ? source.byAssignee : []).forEach(row => rows.push({ group:'assignee', currencyCode:row.currencyCode, name:row.username || 'unassigned', ...row }));
  (Array.isArray(source.byCategory) ? source.byCategory : []).forEach(row => rows.push({ group:'category', currencyCode:row.currencyCode, name:row.category, ...row }));
  return '\uFEFF' + [COLUMNS.map(csvCell).join(','), ...rows.map(row => COLUMNS.map(key => csvCell(row[key])).join(','))].join('\r\n') + '\r\n';
}
module.exports = { COLUMNS, csvCell, buildExceptionPerformanceCsv };
