/*
 * pages/admin/logs.js — 操作日志模块
 * 依赖 SLF.admin 共享上下文
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission } = ctx;

function translateAuditAction(action) {
  const labels = tAdmin('auditAction');
  return (labels && labels[action]) || action;
}

function parseAuditObject(details) {
  if (!details) return '';
  const colonIdx = details.indexOf(':');
  if (colonIdx > 0) return details.substring(colonIdx + 1).trim();
  return details;
}

async function loadAuditLogs() {
  if (!hasPermission('can_view_logs')) {
    $('#auditLogs').innerHTML = '<div class="empty-hint">' + tAdmin('noPermission') + '</div>';
    return;
  }
  try {
    const logs = await api('/admin/audit-logs');
    $('#auditLogs').innerHTML = logs.length ?
      logs.map(log => `<div class="row"><div><b>${SLF.utils.formatDateTime(log.created_at)}</b><small>${esc(log.actor_username || '-')} · ${translateAuditAction(log.action)}${parseAuditObject(log.details) ? ' · ' + esc(parseAuditObject(log.details)) : ''}</small></div><span class="badge">${esc(log.ip || '-')}</span></div>`).join('') :
        `<div class="empty-hint">${tAdmin('noAuditLogs')}</div>`;
  } catch (e) {
    $('#auditLogs').innerHTML = `<div class="empty-hint">${tAdmin('loadFailed')}</div>`;
  }
}

function switchLogTab(tab) {
  $('#logTabLogin').classList.toggle('active', tab === 'login');
  $('#logTabAudit').classList.toggle('active', tab === 'audit');
  $('#loginLogsPanel').style.display = tab === 'login' ? 'block' : 'none';
  $('#auditLogsPanel').style.display = tab === 'audit' ? 'block' : 'none';
  if (tab === 'audit') loadAuditLogs();
}

// 挂到 window 供 onclick 使用
window.translateAuditAction = translateAuditAction;
window.parseAuditObject = parseAuditObject;
window.loadAuditLogs = loadAuditLogs;
window.switchLogTab = switchLogTab;

})();
