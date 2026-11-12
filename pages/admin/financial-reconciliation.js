/*
 * pages/admin/financial-reconciliation.js — 财务对账人工审核工作台
 */
(function () {
  'use strict';

  const ctx = window.SLF && window.SLF.admin;
  if (!ctx) return;
  const { $, api, esc } = ctx;
  const root = () => document.getElementById('financialReconciliationPanel');
  const state = { batches: [], batchId: null, nextBatchCursor: null, nextRowCursor: null, rows: [], loading: false, monthRows: [], monthCurrency: '', closeHistoryCursor: null, closeHistory: [], exceptionRows: [], nextExceptionCursor: null, exceptionLoading: false, exceptionHistory: {} };

  function t(key, fallback) {
    const value = ctx.tAdmin ? ctx.tAdmin(key) : key;
    return value && value !== key ? value : (fallback || key);
  }
  function toast(message) {
    if (window.SLF && SLF.ui && SLF.ui.toast) SLF.ui.toast(message);
  }
  function dateValue(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }
  function moneyMinor(value, currency) {
    const amount = Number(value);
    return Number.isSafeInteger(amount) ? esc(String(amount)) + ' ' + esc(currency || '') + ' ' + t('financeMinorUnits', 'minor units') : '—';
  }
  function statusLabel(status) {
    const labels = {
      pending: t('financePending', 'Pending'), matched: t('financeMatched', 'Matched'),
      unmatched: t('financeUnmatched', 'Unmatched'), ambiguous: t('financeAmbiguous', 'Ambiguous'),
      exception: t('financeException', 'Exception'), imported: t('financeImported', 'Imported'),
      validated: t('financeValidated', 'Validated'), closed: t('financeClosed', 'Closed')
    };
    return labels[status] || esc(status || '—');
  }
  function requirePermission() {
    if (!ctx.hasPermission || !ctx.hasPermission('can_manage_financial_reconciliation')) {
      toast('❌ ' + t('noPermission', 'No permission'));
      return false;
    }
    return true;
  }
  function renderBatchRows(rows) {
    const target = $('#financeBatchList');
    if (!target) return;
    if (!rows.length && !state.batches.length) {
      target.innerHTML = '<div class="empty-hint">' + t('financeNoBatches', 'No reconciliation batches yet') + '</div>';
      return;
    }
    target.innerHTML = rows.map(batch => {
      const counts = [
        t('financeMatched', 'Matched') + ': ' + Number(batch.matched_count || 0),
        t('financePending', 'Pending') + ': ' + Number(batch.pending_count || 0),
        t('financeException', 'Exceptions') + ': ' + Number(batch.exception_count || 0)
      ].join(' · ');
      return '<button type="button" class="finance-batch-card" data-finance-batch="' + Number(batch.id) + '" style="display:block;width:100%;text-align:left;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:14px;margin:8px 0;color:inherit;cursor:pointer;">' +
        '<span style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;"><strong>#' + Number(batch.id) + ' · ' + esc(batch.provider_code) + ' / ' + esc(batch.external_batch_id) + '</strong><span>' + statusLabel(batch.status) + '</span></span>' +
        '<span style="display:block;color:#aaa;font-size:12px;margin-top:6px;">' + esc(batch.imported_at || '') + ' · ' + Number(batch.row_count || 0) + ' ' + t('financeRows', 'rows') + ' · ' + esc(batch.currency_code) + '</span>' +
        '<span style="display:block;color:#bbb;font-size:12px;margin-top:5px;">' + counts + '</span></button>';
    }).join('');
  }
  async function loadBatches(append) {
    if (!requirePermission() || state.loading) return;
    state.loading = true;
    const target = $('#financeBatchList');
    if (!append && target) target.innerHTML = '<div class="empty-hint">' + t('loading', 'Loading…') + '</div>';
    try {
      const query = new URLSearchParams({ limit: '30' });
      if (append && state.nextBatchCursor) query.set('afterId', String(state.nextBatchCursor));
      const data = await api('/admin/financial-reconciliation/batches?' + query.toString());
      const rows = Array.isArray(data.rows) ? data.rows : [];
      state.batches = append ? state.batches.concat(rows) : rows;
      state.nextBatchCursor = data.nextCursor || null;
      renderBatchRows(state.batches);
      const more = $('#financeBatchMore');
      if (more) more.hidden = !state.nextBatchCursor;
    } catch (error) {
      if (target) target.innerHTML = '<div class="empty-hint">' + t('financeLoadFailed', 'Unable to load reconciliation batches') + '</div>';
      toast('❌ ' + (error.message || t('financeLoadFailed', 'Load failed')));
    } finally { state.loading = false; }
  }
  function renderItems() {
    const target = $('#financeReviewRows');
    if (!target) return;
    if (!state.rows.length) {
      target.innerHTML = '<div class="empty-hint">' + t('financeNoRows', 'No statement rows in this batch') + '</div>';
      return;
    }
    target.innerHTML = state.rows.map(row => {
      const suggestion = row.suggestion || {};
      const suggestionText = suggestion.status === 'suggested'
        ? t('financeSuggestedJournal', 'Suggested Ledger transaction') + ' #' + Number(suggestion.journalTransactionId)
        : (suggestion.reason || suggestion.status || '—');
      const canConfirm = suggestion.status === 'suggested' && row.matchStatus !== 'matched';
      const actionButtons = [
        canConfirm ? '<button type="button" data-finance-action="confirm" data-item="' + row.id + '" data-journal="' + Number(suggestion.journalTransactionId) + '">' + t('financeConfirm', 'Confirm') + '</button>' : '',
        row.matchStatus === 'matched' ? '<button type="button" data-finance-action="release" data-item="' + row.id + '">' + t('financeRelease', 'Release') + '</button>' : '',
        row.matchStatus !== 'matched' ? '<button type="button" data-finance-action="reject" data-item="' + row.id + '">' + t('financeReject', 'Reject') + '</button>' : '',
        '<button type="button" data-finance-action="reassign" data-item="' + row.id + '">' + t('financeReassign', 'Reassign') + '</button>',
        '<button type="button" data-finance-action="classify_exception" data-item="' + row.id + '">' + t('financeClassify', 'Classify') + '</button>'
      ].filter(Boolean).join(' ');
      return '<article class="finance-review-row" style="background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:14px;margin:10px 0;">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;"><strong>#' + Number(row.rowNo) + ' · ' + esc(row.externalReference || row.transactionReference || '—') + '</strong><span>' + statusLabel(row.matchStatus) + '</span></div>' +
        '<div style="color:#ccc;font-size:13px;margin:7px 0;">' + moneyMinor(row.amountMinor, row.currencyCode) + ' · ' + esc(row.direction) + ' · ' + esc(row.occurredAt || '') + '</div>' +
        '<div style="color:#aaa;font-size:12px;overflow-wrap:anywhere;">' + esc(row.description || '') + '</div>' +
        '<div style="color:#8ec5ff;font-size:12px;margin-top:7px;">' + esc(suggestionText) + '</div>' +
        (row.exceptionCategory ? '<div style="color:#ffbd70;font-size:12px;margin-top:5px;">' + esc(row.exceptionCategory) + ' · ' + esc(row.exceptionNote || '') + '</div>' : '') +
        '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;">' + actionButtons + '</div></article>';
    }).join('');
  }
  async function loadBatchItems(batchId, append) {
    if (!requirePermission()) return;
    state.batchId = Number(batchId);
    const target = $('#financeReviewRows');
    if (!append) {
      state.rows = [];
      state.nextRowCursor = null;
      if (target) target.innerHTML = '<div class="empty-hint">' + t('loading', 'Loading…') + '</div>';
    }
    try {
      const query = new URLSearchParams({ limit: '100' });
      if (append && state.nextRowCursor) query.set('afterRowNo', String(state.nextRowCursor));
      const data = await api('/admin/financial-reconciliation/batches/:batchId/items'.replace(':batchId', String(state.batchId)) + '?' + query.toString());
      const rows = Array.isArray(data.items) ? data.items : [];
      state.rows = append ? state.rows.concat(rows) : rows;
      state.nextRowCursor = data.nextCursor || null;
      const title = $('#financeSelectedBatch');
      if (title) title.textContent = '#' + data.batch.id + ' · ' + data.batch.currencyCode + ' · ' + data.batch.rowCount + ' ' + t('financeRows', 'rows');
      renderItems();
      const more = $('#financeRowsMore');
      if (more) more.hidden = !state.nextRowCursor;
    } catch (error) {
      if (target) target.innerHTML = '<div class="empty-hint">' + t('financeLoadFailed', 'Unable to load statement rows') + '</div>';
      toast('❌ ' + (error.message || 'Load failed'));
    }
  }
  function requestReason(action) {
    const prompts = {
      confirm: t('financeReasonConfirm', 'Reason for confirming this match (5–500 characters):'),
      reject: t('financeReasonReject', 'Reason for rejecting this row (5–500 characters):'),
      release: t('financeReasonRelease', 'Reason for releasing this allocation (5–500 characters):'),
      reassign: t('financeReasonReassign', 'Reason for reassigning this row (5–500 characters):'),
      classify_exception: t('financeReasonClassify', 'Reason for classifying this exception (5–500 characters):')
    };
    const reason = window.prompt(prompts[action] || t('financeReason', 'Reason (5–500 characters):'));
    if (reason === null) return null;
    if (reason.trim().length < 5 || reason.trim().length > 500) {
      toast('❌ ' + t('financeReasonInvalid', 'Reason must contain 5–500 characters'));
      return null;
    }
    return reason.trim();
  }
  async function submitReview(button) {
    if (!requirePermission()) return;
    const itemId = Number(button.dataset.item);
    const action = button.dataset.financeAction;
    const reason = requestReason(action);
    if (!reason) return;
    const body = { batchId: state.batchId, action, reason,
      idempotencyKey: 'finance-ui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 12) };
    if (action === 'confirm') body.journalTransactionId = Number(button.dataset.journal);
    if (action === 'reassign') {
      const id = Number(window.prompt(t('financeJournalIdPrompt', 'Enter Ledger transaction ID:')));
      if (!Number.isSafeInteger(id) || id <= 0) return;
      body.journalTransactionId = id;
    }
    if (action === 'classify_exception') {
      const category = String(window.prompt(t('financeCategoryPrompt', 'Category: refund, fee, settlement_difference, chargeback, other'), 'other') || '').trim();
      if (!['refund', 'fee', 'settlement_difference', 'chargeback', 'other'].includes(category)) {
        toast('❌ ' + t('financeCategoryInvalid', 'Unsupported exception category'));
        return;
      }
      body.exceptionCategory = category;
    }
    button.disabled = true;
    try {
      await api('/admin/financial-reconciliation/items/:itemId/review'.replace(':itemId', String(itemId)), { method: 'POST', body });
      toast('✅ ' + t('financeReviewSaved', 'Review saved'));
      await loadBatchItems(state.batchId, false);
      await loadBatches(false);
    } catch (error) {
      toast('❌ ' + (error.message || t('financeReviewFailed', 'Review failed')));
    } finally { button.disabled = false; }
  }
  async function importBatch() {
    if (!requirePermission()) return;
    const input = $('#financeImportJson');
    let parsed;
    try { parsed = JSON.parse(input.value || ''); }
    catch (_) { toast('❌ ' + t('financeInvalidJson', 'Invalid JSON')); return; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      toast('❌ ' + t('financeInvalidJson', 'Invalid JSON object')); return;
    }
    const body = {
      providerCode: parsed.providerCode, externalBatchId: parsed.externalBatchId,
      statementSha256: parsed.statementSha256, currencyCode: parsed.currencyCode, rows: parsed.rows
    };
    const button = $('#financeImportButton');
    button.disabled = true;
    try {
      const result = await api('/admin/financial-reconciliation/batches/import', { method: 'POST', body });
      toast('✅ ' + t('financeImportDone', 'Batch imported') + ' #' + result.batchId);
      input.value = '';
      await loadBatches(false);
      await loadBatchItems(result.batchId, false);
    } catch (error) { toast('❌ ' + (error.message || t('financeImportFailed', 'Import failed'))); }
    finally { button.disabled = false; }
  }
  function exportDailyCsv(rows) {
    if (!rows.length) { toast(t('financeNoReportRows', 'No report rows')); return; }
    const columns = ['report_date', 'currency_code', 'batch_count', 'statement_row_count', 'total_debit_minor', 'total_credit_minor', 'matched_count', 'pending_count', 'unmatched_count', 'ambiguous_count', 'exception_count', 'refund_exception_count', 'fee_exception_count', 'settlement_difference_exception_count', 'chargeback_exception_count', 'other_exception_count'];
    const csv = [columns.join(','), ...rows.map(row => columns.map(key => {
      const value = String(row[key] ?? '');
      return '"' + value.replace(/"/g, '""') + '"';
    }).join(','))].join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'financial-reconciliation-daily.csv';
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }
  async function loadDailySummary(exportCsv) {
    if (!requirePermission()) return;
    const from = $('#financeReportFrom').value;
    const to = $('#financeReportTo').value;
    try {
      const data = await api('/admin/financial-reconciliation/daily-summary?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const target = $('#financeDailyReport');
      target.innerHTML = rows.length ? '<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr>' +
        ['report_date','currency_code','batch_count','statement_row_count','matched_count','pending_count','unmatched_count','ambiguous_count','exception_count'].map(key => '<th style="text-align:left;padding:9px;border-bottom:1px solid #555;">' + esc(t('financeCol_' + key, key)) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.map(row => '<tr>' + ['report_date','currency_code','batch_count','statement_row_count','matched_count','pending_count','unmatched_count','ambiguous_count','exception_count'].map(key => '<td style="padding:9px;border-bottom:1px solid rgba(255,255,255,.08);">' + esc(row[key] ?? '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' : '<div class="empty-hint">' + t('financeNoReportRows', 'No report rows') + '</div>';
      if (exportCsv) exportDailyCsv(rows);
    } catch (error) { toast('❌ ' + (error.message || t('financeLoadFailed', 'Load failed'))); }
  }


  function renderSlaAlerts(items) {
    const target=$('#financeSlaAlertList');if(!target)return;
    if(!items.length){target.innerHTML='<div class="empty-hint">暂无待确认 SLA 提醒</div>';return;}
    target.innerHTML=items.map(item=>{
      const actions=item.status==='pending'
        ? '<button type="button" data-sla-alert-ack="'+Number(item.alertId)+'">确认已知悉</button> <button type="button" data-sla-alert-dismiss="'+Number(item.alertId)+'">关闭提醒</button>'
        : '<span style="font-size:12px;color:#aaa;">'+esc(item.status)+'</span>';
      return '<article style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,.08);"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;"><strong>异常 #'+Number(item.itemId)+' · '+esc(item.category||'未分类')+'</strong><span>'+esc(item.status)+' · '+formatAge(item.ageSeconds)+' / SLA '+Number(item.slaHours)+'h</span></div><div style="font-size:12px;color:#aaa;margin:5px 0;">'+esc(item.externalReference||'无外部流水号')+' · '+esc(item.assignedAdminUsername||'未分配')+' · '+moneyMinor(item.amountMinor,item.currencyCode)+'</div>'+actions+' <button type="button" data-sla-alert-history="'+Number(item.alertId)+'">查看审计历史</button><div id="financeSlaAlertHistory-'+Number(item.alertId)+'" hidden style="margin-top:8px;"></div></article>';
    }).join('');
  }
  async function loadSlaAlerts() {
    if(!requirePermission())return;
    const target=$('#financeSlaAlertList');if(target)target.innerHTML='<div class="empty-hint">加载中…</div>';
    try{const status=$('#financeSlaAlertStatus')?.value||'pending';const data=await api('/admin/financial-reconciliation/exceptions/alerts?status='+encodeURIComponent(status)+'&limit=50');renderSlaAlerts(Array.isArray(data.items)?data.items:[]);}
    catch(error){if(target)target.innerHTML='<div class="empty-hint">提醒加载失败</div>';toast('❌ '+(error.message||'提醒加载失败'));}
  }
  async function generateSlaAlerts() {
    if(!requirePermission())return;
    const raw=Number($('#financeExceptionSlaHours')?.value||24),slaHours=Number.isSafeInteger(raw)&&raw>=1&&raw<=720?raw:24;
    try{const result=await api('/admin/financial-reconciliation/exceptions/alerts/generate',{method:'POST',body:{slaHours}});
      toast('✅ 已扫描 '+Number(result.scanned)+' 条超时异常，新建提醒 '+Number(result.created)+' 条');await loadSlaAlerts();}
    catch(error){toast('❌ '+(error.message||'生成提醒失败'));}
  }
  async function acknowledgeSlaAlert(button) {
    if(!requirePermission())return;
    const reason=window.prompt('请输入确认说明（5–500 字）：');if(reason===null)return;
    if(reason.trim().length<5||reason.trim().length>500){toast('❌ 确认说明长度必须为 5–500 字');return;}
    button.disabled=true;
    try{await api('/admin/financial-reconciliation/exceptions/alerts/'+Number(button.dataset.slaAlertAck)+'/acknowledge',{method:'POST',body:{reason:reason.trim(),idempotencyKey:'sla-alert-ack-'+Date.now()+'-'+Math.random().toString(36).slice(2,10)}});
      toast('✅ 已记录提醒确认');await loadSlaAlerts();await loadExceptionOperations();}
    catch(error){toast('❌ '+(error.message||'确认提醒失败'));}
    finally{button.disabled=false;}
  }
  async function dismissSlaAlert(button) {
    if(!requirePermission())return;
    const reason=window.prompt('请输入关闭提醒原因（5–500 字，不会关闭底层异常）：');if(reason===null)return;
    if(reason.trim().length<5||reason.trim().length>500){toast('❌ 关闭原因长度必须为 5–500 字');return;}
    button.disabled=true;
    try{
      await api('/admin/financial-reconciliation/exceptions/alerts/'+Number(button.dataset.slaAlertDismiss)+'/dismiss',{method:'POST',body:{reason:reason.trim(),idempotencyKey:'sla-alert-dismiss-'+Date.now()+'-'+Math.random().toString(36).slice(2,10)}});
      toast('✅ 已关闭提醒（底层异常未变更）');await loadSlaAlerts();
    }catch(error){toast('❌ '+(error.message||'关闭提醒失败'));}
    finally{button.disabled=false;}
  }
  function setReportRange(kind) {
    const now=new Date(),to=dateValue(now),from=new Date(now);
    if(kind==='week')from.setDate(from.getDate()-6);
    else if(kind==='month')from.setDate(from.getDate()-29);
    else if(kind==='calendar-month')from.setDate(1);
    const fromInput=$('#financeReportFrom'),toInput=$('#financeReportTo');
    if(fromInput)fromInput.value=dateValue(from);if(toInput)toInput.value=to;loadDailySummary(false);
  }

  async function loadSlaAlertHistory(alertId) {
    const target=$('#financeSlaAlertHistory-'+Number(alertId));if(!target)return;
    if(!target.hidden){target.hidden=true;return;}
    target.hidden=false;target.innerHTML='<div class="empty-hint">加载审计历史…</div>';
    try{const data=await api('/admin/financial-reconciliation/exceptions/alerts/'+Number(alertId)+'/history?limit=50');const rows=Array.isArray(data.items)?data.items:[];
      target.innerHTML=rows.length?rows.map(row=>'<div style="padding:8px 0;border-top:1px solid rgba(255,255,255,.08);"><strong>'+esc(row.action)+'</strong> · '+esc(row.actorUsername)+' · '+esc(row.createdAt||'')+'<div style="font-size:12px;color:#aaa;">'+esc(row.reason)+'</div><div style="font-size:11px;color:#888;word-break:break-all;">Hash: '+esc(row.eventHash)+'</div></div>').join(''):'<div class="empty-hint">暂无审计事件</div>';
    }catch(error){target.innerHTML='<div class="empty-hint">审计历史加载失败</div>';toast('❌ '+(error.message||'审计历史加载失败'));}
  }
  async function loadPeriodSummary(period,exportCsv=false) {
    if(!requirePermission())return;const from=$('#financeReportFrom')?.value,to=$('#financeReportTo')?.value,target=$('#financePeriodReport');
    if(!from||!to){toast('请先选择开始和结束日期');return;}if(target)target.innerHTML='<div class="empty-hint">加载周期报表…</div>';
    try{const data=await api('/admin/financial-reconciliation/period-summary?period='+encodeURIComponent(period)+'&from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to));
      const rows=Array.isArray(data.rows)?data.rows:[],columns=['periodStart','periodEnd','currencyCode','batchCount','statementRowCount','totalDebitMinor','totalCreditMinor','matchedCount','pendingCount','unmatchedCount','ambiguousCount','exceptionCount'];
      if(target)target.innerHTML=rows.length?'<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr>'+columns.map(k=>'<th style="text-align:left;padding:8px;border-bottom:1px solid #555;">'+esc(k)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+columns.map(k=>'<td style="padding:8px;border-bottom:1px solid rgba(255,255,255,.08);">'+esc(row[k]??'')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>':'<div class="empty-hint">所选周期暂无对账数据</div>';
      if(exportCsv&&rows.length){const csv=[columns.join(','),...rows.map(row=>columns.map(k=>{const v=String(row[k]??'');return '"'+v.replace(/"/g,'""')+'"';}).join(','))].join('\r\n');const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='financial-reconciliation-'+period+'-summary.csv';document.body.appendChild(link);link.click();link.remove();URL.revokeObjectURL(url);}
    }catch(error){if(target)target.innerHTML='<div class="empty-hint">周期报表加载失败</div>';toast('❌ '+(error.message||'周期报表加载失败'));}
  }
  function exceptionStatusLabel(status) {
    const labels = {
      open: t('financeExceptionOpen', 'Open'),
      in_progress: t('financeExceptionInProgress', 'In progress'),
      resolved: t('financeExceptionResolved', 'Resolved'),
      closed: t('financeExceptionClosed', 'Closed')
    };
    return labels[status] || esc(status || '—');
  }
  function renderExceptionQueue() {
    const target = $('#financeExceptionQueue');
    if (!target) return;
    if (!state.exceptionRows.length) {
      target.innerHTML = '<div class="empty-hint">' + t('financeExceptionNoRows', 'No exceptions match these filters') + '</div>';
      return;
    }
    target.innerHTML = state.exceptionRows.map(row => {
      const status = row.caseStatus || 'open';
      const actions = [
        status !== 'closed' ? '<button type="button" data-exception-action="assign" data-item="' + Number(row.itemId) + '" data-batch="' + Number(row.batchId) + '">' + t('financeExceptionAssign', 'Assign') + '</button>' : '',
        row.assignedAdminId && status !== 'closed' ? '<button type="button" data-exception-action="unassign" data-item="' + Number(row.itemId) + '" data-batch="' + Number(row.batchId) + '">' + t('financeExceptionUnassign', 'Unassign') + '</button>' : '',
        status === 'open' ? '<button type="button" data-exception-action="start" data-item="' + Number(row.itemId) + '" data-batch="' + Number(row.batchId) + '">' + t('financeExceptionStart', 'Start') + '</button>' : '',
        status !== 'closed' ? '<button type="button" data-exception-action="add_note" data-item="' + Number(row.itemId) + '" data-batch="' + Number(row.batchId) + '">' + t('financeExceptionAddNote', 'Add note') + '</button>' : '',
        ['open','in_progress'].includes(status) ? '<button type="button" data-exception-action="resolve" data-item="' + Number(row.itemId) + '" data-batch="' + Number(row.batchId) + '">' + t('financeExceptionResolve', 'Resolve') + '</button>' : '',
        status === 'resolved' ? '<button type="button" data-exception-action="close" data-item="' + Number(row.itemId) + '" data-batch="' + Number(row.batchId) + '">' + t('financeExceptionClose', 'Close case') + '</button>' : '',
        ['resolved','closed'].includes(status) ? '<button type="button" data-exception-action="reopen" data-item="' + Number(row.itemId) + '" data-batch="' + Number(row.batchId) + '">' + t('financeExceptionReopen', 'Reopen') + '</button>' : ''
      ].filter(Boolean).join(' ');
      return '<article style="background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:14px;margin:10px 0;">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;"><strong>#' + Number(row.itemId) + ' · ' + esc(row.externalReference || row.transactionReference || '—') + '</strong><span>' + exceptionStatusLabel(status) + '</span></div>' +
        '<div style="font-size:13px;color:#ccc;margin:7px 0;">' + moneyMinor(row.amountMinor, row.currencyCode) + ' · ' + esc(row.direction) + ' · ' + esc(row.category || '') + ' · ' + esc(row.importedAt || '') + '</div>' +
        '<div style="font-size:12px;color:#aaa;">' + esc(row.description || '') + '</div>' +
        '<div style="font-size:12px;margin-top:7px;">' + t('financeExceptionAssignedTo', 'Assigned to') + ': ' + esc(row.assignedAdminUsername || '—') + '</div>' +
        (row.resolutionNote ? '<div style="font-size:12px;color:#aaa;margin-top:5px;">' + t('financeExceptionResolution', 'Resolution') + ': ' + esc(row.resolutionNote) + '</div>' : '') +
        '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;">' + actions +
        '<button type="button" data-exception-history="' + Number(row.itemId) + '" data-batch="' + Number(row.batchId) + '">' + t('financeExceptionAuditHistory', 'Audit history') + '</button></div>' +
        '<div id="financeExceptionHistory-' + Number(row.itemId) + '" hidden style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08);"></div></article>';
    }).join('');
    const more = $('#financeExceptionMore');
    if (more) more.hidden = !state.nextExceptionCursor;
  }
  async function loadExceptionQueue(append) {
    if (!requirePermission() || state.exceptionLoading) return;
    state.exceptionLoading = true;
    const target = $('#financeExceptionQueue');
    if (!append) {
      state.exceptionRows = [];
      state.nextExceptionCursor = null;
      state.exceptionHistory = {};
      if (target) target.innerHTML = '<div class="empty-hint">' + t('loading', 'Loading…') + '</div>';
    }
    try {
      const query = new URLSearchParams({ limit: '50' });
      const category = $('#financeExceptionCategory')?.value || 'all';
      const status = $('#financeExceptionStatus')?.value || 'all';
      if (category !== 'all') query.set('category', category);
      if (status !== 'all') query.set('status', status);
      if (append && state.nextExceptionCursor) query.set('afterId', String(state.nextExceptionCursor));
      const data = await api('/admin/financial-reconciliation/exceptions?' + query.toString());
      const rows = Array.isArray(data.items) ? data.items : [];
      state.exceptionRows = append ? state.exceptionRows.concat(rows) : rows;
      state.nextExceptionCursor = data.nextCursor || null;
      renderExceptionQueue();
    } catch (error) {
      if (target) target.innerHTML = '<div class="empty-hint">' + t('financeLoadFailed', 'Unable to load exceptions') + '</div>';
      toast('❌ ' + (error.message || t('financeLoadFailed', 'Load failed')));
    } finally { state.exceptionLoading = false; }
  }

  async function loadExceptionHistory(button, append) {
    const itemId = Number(button.dataset.item);
    const batchId = Number(button.dataset.batch);
    if (!Number.isSafeInteger(itemId) || itemId <= 0 || !Number.isSafeInteger(batchId) || batchId <= 0) return;
    const target = $('#financeExceptionHistory-' + itemId);
    if (!target) return;
    const stateKey = String(itemId);
    const history = state.exceptionHistory[stateKey] || { items: [], nextCursor: null, loaded: false };
    target.hidden = false;
    try {
      const query = new URLSearchParams({ batchId: String(batchId), limit: '50' });
      if (append && history.nextCursor) query.set('afterId', String(history.nextCursor));
      const data = await api('/admin/financial-reconciliation/exceptions/' + itemId + '/history?' + query.toString());
      history.items = append ? history.items.concat(data.items || []) : (data.items || []);
      history.nextCursor = data.nextCursor || null;
      history.loaded = true;
      state.exceptionHistory[stateKey] = history;
      target.innerHTML = history.items.map(event =>
        '<article style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06);">' +
        '<strong>#' + Number(event.eventId) + ' · ' + esc(event.action) + '</strong> · ' +
        esc(event.before?.status || '—') + ' → ' + esc(event.after?.status || '—') +
        '<div style="font-size:12px;color:#aaa;margin-top:4px;">' + esc(event.actorUsername) + ' · ' + esc(event.createdAt) + '</div>' +
        '<div style="font-size:12px;margin-top:4px;">' + esc(event.reason) + '</div>' +
        '<div style="font-size:11px;color:#888;overflow-wrap:anywhere;">SHA-256: ' + esc(event.eventHash) + '</div></article>'
      ).join('') + (history.nextCursor
        ? '<button type="button" data-exception-history-more="' + itemId + '" data-batch="' + batchId + '">Load more audit events</button>' : '');
    } catch (error) {
      target.innerHTML = '<div class="empty-hint">' + t('financeLoadFailed', 'Unable to load audit history') + '</div>';
      toast('❌ ' + (error.message || t('financeLoadFailed', 'Load failed')));
    }
  }
  async function submitExceptionAction(button) {
    if (!requirePermission()) return;
    const action = button.dataset.exceptionAction;
    const itemId = Number(button.dataset.item);
    const batchId = Number(button.dataset.batch);
    let assignedAdminId;
    if (action === 'assign') {
      assignedAdminId = Number(window.prompt(t('financeExceptionAssigneePrompt', 'Enter active merchant administrator ID:')));
      if (!Number.isSafeInteger(assignedAdminId) || assignedAdminId <= 0) return;
    }
    const reason = window.prompt(t('financeExceptionReasonPrompt', 'Enter handling note / reason (5–500 characters):'));
    if (reason === null) return;
    if (reason.trim().length < 5 || reason.trim().length > 500) {
      toast('❌ ' + t('financeReasonInvalid', 'Reason must contain 5–500 characters'));
      return;
    }
    const body = {
      batchId, action, reason: reason.trim(),
      idempotencyKey: 'finance-exception-ui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)
    };
    if (assignedAdminId) body.assignedAdminId = assignedAdminId;
    button.disabled = true;
    try {
      await api('/admin/financial-reconciliation/exceptions/' + itemId + '/workflow', { method: 'POST', body });
      toast('✅ ' + t('financeExceptionActionSaved', 'Exception handling action recorded'));
      await loadExceptionQueue(false);
    } catch (error) {
      toast('❌ ' + (error.message || t('financeExceptionActionFailed', 'Exception handling action failed')));
    } finally { button.disabled = false; }
  }
  function formatAge(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const days = Math.floor(value / 86400), hours = Math.floor((value % 86400) / 3600);
    return days ? days + '天 ' + hours + '小时' : hours + '小时';
  }
  function renderExceptionOperations(data) {
    const summary = $('#financeExceptionOpsSummary'), workload = $('#financeExceptionOpsWorkload');
    const trend = $('#financeExceptionOpsTrend'), overdue = $('#financeExceptionOpsOverdue');
    if (!summary || !workload || !trend || !overdue) return;
    const totals = data.summary || {}, ageing = totals.ageing || {};
    summary.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;">' +
      [['待处理',totals.openCount],['处理中',totals.inProgressCount],['活跃异常',totals.activeCount],
       ['超过 '+Number(data.slaHours)+' 小时',totals.overdueCount],['24 小时内',ageing.under24Hours],
       ['1–3 天',ageing.from1To3Days],['3–7 天',ageing.from3To7Days],['超过 7 天',ageing.over7Days]]
      .map(pair => '<div style="padding:12px;border:1px solid rgba(255,255,255,.1);border-radius:10px;"><div style="font-size:12px;color:#aaa;">'+esc(pair[0])+'</div><strong style="font-size:22px;">'+Number(pair[1]||0)+'</strong></div>').join('')+'</div>';
    const people = Array.isArray(data.workload) ? data.workload : [];
    workload.innerHTML = people.length ? '<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr><th style="text-align:left;padding:8px;">负责人</th><th style="text-align:right;padding:8px;">活跃</th><th style="text-align:right;padding:8px;">超时</th><th style="text-align:right;padding:8px;">最老账龄</th></tr></thead><tbody>'+
      people.map(row=>'<tr><td style="padding:8px;border-top:1px solid rgba(255,255,255,.08);">'+esc(row.username||'未分配')+'</td><td style="text-align:right;padding:8px;">'+Number(row.activeCount)+'</td><td style="text-align:right;padding:8px;">'+Number(row.overdueCount)+'</td><td style="text-align:right;padding:8px;">'+formatAge(row.oldestAgeSeconds)+'</td></tr>').join('')+'</tbody></table></div>' : '<div class="empty-hint">暂无活跃异常</div>';
    const days = Array.isArray(data.trend) ? data.trend : [];
    trend.innerHTML = days.length ? '<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr><th style="text-align:left;padding:8px;">日期</th><th style="text-align:right;padding:8px;">新增异常</th><th style="text-align:right;padding:8px;">解决事件</th></tr></thead><tbody>'+
      days.map(row=>'<tr><td style="padding:8px;border-top:1px solid rgba(255,255,255,.08);">'+esc(row.date)+'</td><td style="text-align:right;padding:8px;">'+Number(row.openedCount)+'</td><td style="text-align:right;padding:8px;">'+Number(row.resolvedEventCount)+'</td></tr>').join('')+'</tbody></table></div>' : '<div class="empty-hint">近 30 天暂无异常事件</div>';
    const overdueRows = Array.isArray(data.overdueItems) ? data.overdueItems : [];
    overdue.innerHTML = overdueRows.length ? overdueRows.map(row=>'<article style="padding:9px 0;border-bottom:1px solid rgba(255,255,255,.08);"><strong>#'+Number(row.itemId)+' · '+esc(row.category||'未分类')+'</strong><div style="font-size:12px;color:#aaa;margin-top:4px;">'+esc(row.externalReference||'无外部流水号')+' · '+esc(row.assignedAdminUsername||'未分配')+' · 账龄 '+formatAge(row.ageSeconds)+' · '+moneyMinor(row.amountMinor,row.currencyCode)+'</div></article>').join('') : '<div class="empty-hint">当前没有超过 SLA 的活跃异常</div>';
  }
  async function loadExceptionOperations() {
    if (!requirePermission()) return;
    const target = $('#financeExceptionOpsSummary');
    if (target) target.innerHTML = '<div class="empty-hint">'+t('loading','Loading…')+'</div>';
    const raw = Number($('#financeExceptionSlaHours')?.value || 24);
    const slaHours = Number.isSafeInteger(raw) && raw >= 1 && raw <= 720 ? raw : 24;
    try {
      const data = await api('/admin/financial-reconciliation/exceptions/operations-summary?slaHours='+encodeURIComponent(String(slaHours)));
      renderExceptionOperations(data);
    } catch (error) {
      if (target) target.innerHTML = '<div class="empty-hint">'+t('financeLoadFailed','Unable to load exception operations')+'</div>';
      toast('❌ '+(error.message||t('financeLoadFailed','Load failed')));
    }
  }
  function monthStatusLabel(status) {
    const labels = {
      open: t('financeMonthOpen', 'Open'),
      close_pending: t('financeMonthClosePending', 'Close approval pending'),
      locked: t('financeMonthLocked', 'Locked'),
      reopen_pending: t('financeMonthReopenPending', 'Reopen approval pending')
    };
    return labels[status] || esc(status || '—');
  }
  function renderMonthPreview() {
    const target = $('#financeMonthPreview');
    const select = $('#financeCloseCurrency');
    if (!target || !select) return;
    const rows = state.monthRows;
    const previous = state.monthCurrency;
    select.innerHTML = rows.map(row => '<option value="' + esc(row.currencyCode) + '">' + esc(row.currencyCode) + '</option>').join('');
    if (rows.some(row => row.currencyCode === previous)) select.value = previous;
    state.monthCurrency = select.value || '';
    if (!rows.length) {
      target.innerHTML = '<div class="empty-hint">' + t('financeMonthNoBatches', 'No imported batches for this month and store') + '</div>';
      $('#financeCloseStatus').innerHTML = '<div class="empty-hint">' + t('financeMonthNoPeriod', 'No monthly close period is available') + '</div>';
      $('#financeCloseActions').innerHTML = '';
      $('#financeCloseHistory').innerHTML = '';
      return;
    }
    target.innerHTML = '<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr>' +
      ['currencyCode','batchCount','statementRowCount','totalDebitMinor','totalCreditMinor','matchedCount','unresolvedCount'].map(key =>
        '<th style="text-align:left;padding:9px;border-bottom:1px solid #555;">' + esc(t('financeMonth_' + key, key)) + '</th>').join('') +
      '</tr></thead><tbody>' + rows.map(row => '<tr>' +
        [row.currencyCode,row.batchCount,row.statementRowCount,row.totalDebitMinor,row.totalCreditMinor,row.matchedCount,row.unresolvedCount].map(value =>
          '<td style="padding:9px;border-bottom:1px solid rgba(255,255,255,.08);">' + esc(value ?? '') + '</td>').join('') +
        '</tr>').join('') + '</tbody></table></div>';
  }
  function renderMonthPeriod(period) {
    const status = $('#financeCloseStatus');
    const actions = $('#financeCloseActions');
    if (!status || !actions) return;
    const periodExists = Boolean(period);
    period = period || { status: 'open' };
    const details = [
      !periodExists ? t('financeMonthNotInitialized', 'No close request has been submitted yet') : '',
      t('financeMonthStatus', 'Status') + ': ' + monthStatusLabel(period.status),
      period.pendingActorUsername ? t('financeMonthRequestedBy', 'Requested by') + ': ' + esc(period.pendingActorUsername) : '',
      period.pendingReason ? t('financeMonthReason', 'Reason') + ': ' + esc(period.pendingReason) : '',
      period.lockedByAdminId ? t('financeMonthLockedBy', 'Locked by administrator') + ': #' + Number(period.lockedByAdminId) : '',
      period.lockedAt ? t('financeMonthLockedAt', 'Locked at') + ': ' + esc(period.lockedAt) : ''
    ].filter(Boolean);
    status.innerHTML = '<div style="display:grid;gap:6px;">' + details.map(line => '<div>' + line + '</div>').join('') + '</div>';
    const row = state.monthRows.find(item => item.currencyCode === state.monthCurrency);
    const ready = Boolean(row && row.closeReady && Number(row.statementRowCount) > 0);
    let choices = [];
    if (period.status === 'open') choices = [{ action: 'request_close', label: t('financeMonthRequestClose', 'Request close'), disabled: !ready }];
    if (period.status === 'close_pending') choices = [
      { action: 'approve_close', label: t('financeMonthApproveClose', 'Approve close') },
      { action: 'reject_close', label: t('financeMonthRejectClose', 'Reject close') }
    ];
    if (period.status === 'locked') choices = [{ action: 'request_reopen', label: t('financeMonthRequestReopen', 'Request reopen') }];
    if (period.status === 'reopen_pending') choices = [
      { action: 'approve_reopen', label: t('financeMonthApproveReopen', 'Approve reopen') },
      { action: 'reject_reopen', label: t('financeMonthRejectReopen', 'Reject reopen') }
    ];
    actions.innerHTML = choices.map(choice => '<button type="button" data-month-close-action="' + choice.action + '"' +
      (choice.disabled ? ' disabled title="' + esc(t('financeMonthNotReady', 'All statement rows must be matched before close')) + '"' : '') +
      ' style="margin:6px 6px 0 0;">' + esc(choice.label) + '</button>').join('');
  }
  async function loadMonthHistory() {
    if (!requirePermission() || !state.monthCurrency) return;
    const target = $('#financeCloseHistory');
    if (!target) return;
    try {
      const month = $('#financeCloseMonth').value;
      const query = new URLSearchParams({ month, currencyCode: state.monthCurrency, limit: '50' });
      if (state.closeHistoryCursor) query.set('afterId', String(state.closeHistoryCursor));
      const data = await api('/admin/financial-reconciliation/month-close/history?' + query.toString());
      const items = Array.isArray(data.items) ? data.items : [];
      state.closeHistory = state.closeHistoryCursor ? state.closeHistory.concat(items) : items;
      state.closeHistoryCursor = data.nextCursor || null;
      target.innerHTML = state.closeHistory.length ? state.closeHistory.map(item =>
        '<article style="border-bottom:1px solid rgba(255,255,255,.08);padding:9px 0;">' +
        '<strong>#' + Number(item.eventId) + ' · ' + esc(item.action) + '</strong> · ' +
        esc(item.beforeStatus) + ' → ' + esc(item.afterStatus) +
        '<div style="font-size:12px;color:#aaa;margin-top:4px;">' + esc(item.actorUsername) + ' · ' + esc(item.createdAt) + '</div>' +
        '<div style="font-size:12px;margin-top:4px;">' + esc(item.reason) + '</div>' +
        '<div style="font-size:11px;color:#888;overflow-wrap:anywhere;">SHA-256: ' + esc(item.eventHash) + '</div></article>'
      ).join('') : '<div class="empty-hint">' + t('financeMonthNoHistory', 'No approval history') + '</div>';
      const more = $('#financeCloseHistoryMore');
      if (more) more.hidden = !state.closeHistoryCursor;
    } catch (error) {
      target.innerHTML = '<div class="empty-hint">' + t('financeLoadFailed', 'Unable to load monthly close history') + '</div>';
      toast('❌ ' + (error.message || t('financeLoadFailed', 'Load failed')));
    }
  }
  async function loadMonthPeriod() {
    if (!requirePermission() || !state.monthCurrency) return;
    const month = $('#financeCloseMonth').value;
    try {
      const query = new URLSearchParams({ month, currencyCode: state.monthCurrency });
      const data = await api('/admin/financial-reconciliation/month-close/period?' + query.toString());
      renderMonthPeriod(data.period || null);
      state.closeHistoryCursor = null;
      state.closeHistory = [];
      await loadMonthHistory();
    } catch (error) {
      toast('❌ ' + (error.message || t('financeLoadFailed', 'Load failed')));
    }
  }
  async function loadMonthlyClose() {
    if (!requirePermission()) return;
    const monthInput = $('#financeCloseMonth');
    if (!monthInput) return;
    const now = new Date();
    if (!monthInput.value) monthInput.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    try {
      const data = await api('/admin/financial-reconciliation/monthly-close-preview?month=' + encodeURIComponent(monthInput.value));
      state.monthRows = Array.isArray(data.rows) ? data.rows : [];
      renderMonthPreview();
      await loadMonthPeriod();
    } catch (error) {
      toast('❌ ' + (error.message || t('financeLoadFailed', 'Load failed')));
    }
  }
  async function submitMonthClose(button) {
    if (!requirePermission() || !state.monthCurrency) return;
    const action = button.dataset.monthCloseAction;
    const reason = window.prompt(t('financeMonthReasonPrompt', 'Enter an audit reason (5–500 characters):'));
    if (reason === null) return;
    if (reason.trim().length < 5 || reason.trim().length > 500) {
      toast('❌ ' + t('financeReasonInvalid', 'Reason must contain 5–500 characters'));
      return;
    }
    const body = {
      month: $('#financeCloseMonth').value,
      currencyCode: state.monthCurrency,
      action,
      reason: reason.trim(),
      idempotencyKey: 'month-close-ui-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)
    };
    button.disabled = true;
    try {
      await api('/admin/financial-reconciliation/month-close/transition', { method: 'POST', body });
      toast('✅ ' + t('financeMonthActionSaved', 'Monthly close action recorded'));
      await loadMonthlyClose();
    } catch (error) {
      toast('❌ ' + (error.message || t('financeMonthActionFailed', 'Monthly close action failed')));
    } finally { button.disabled = false; }
  }

  function performancePercent(value) { return value === null || value === undefined ? '—' : Number(value).toFixed(2) + '%'; }
  function renderPerformanceTable(targetId, rows, columns, emptyText) {
    const target=$('#'+targetId);if(!target)return;
    if(!rows.length){target.innerHTML='<div class="empty-hint">'+esc(emptyText)+'</div>';return;}
    target.innerHTML='<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr>'+
      columns.map(col=>'<th style="text-align:left;padding:8px;border-bottom:1px solid #555;white-space:nowrap;">'+esc(col.label)+'</th>').join('')+
      '</tr></thead><tbody>'+rows.map(row=>'<tr>'+columns.map(col=>'<td style="padding:8px;border-bottom:1px solid rgba(255,255,255,.08);">'+esc(col.format?col.format(row[col.key]):(row[col.key]??'—'))+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
  }
  function renderExceptionPerformance(data) {
    const summary=$('#financeExceptionPerformanceSummary');
    const currencies=Array.isArray(data.byCurrency)?data.byCurrency:[],assignees=Array.isArray(data.byAssignee)?data.byAssignee:[],categories=Array.isArray(data.byCategory)?data.byCategory:[];
    if(summary)summary.innerHTML='<div style="display:flex;gap:10px;flex-wrap:wrap;"><span>当前 SLA：<strong>'+Number(data.slaHours)+' 小时</strong></span><span>统计币种：<strong>'+currencies.length+'</strong></span><span>活跃异常：<strong>'+currencies.reduce((n,r)=>n+Number(r.activeCount||0),0)+'</strong></span><span>超时异常：<strong>'+currencies.reduce((n,r)=>n+Number(r.overdueActiveCount||0),0)+'</strong></span></div><p class="ff-desc" style="margin-top:8px;">'+esc(data.metricDefinitions?.onTimeResolutionRate||'按不可变 resolve 事件统计')+'；平均耗时从批次导入时间起算，不代表员工实际处理净耗时。</p>';
    renderPerformanceTable('financeExceptionPerformanceCurrency',currencies,[
      {key:'currencyCode',label:'币种'},{key:'activeCount',label:'活跃异常'},{key:'overdueActiveCount',label:'超时异常'},
      {key:'overdueRatePercent',label:'超时率',format:performancePercent},{key:'resolvedEventCount',label:'解决事件'},
      {key:'onTimeResolvedEventCount',label:'SLA 内解决事件'},{key:'onTimeResolutionRatePercent',label:'按时解决率',format:performancePercent},
      {key:'avgImportToResolveSeconds',label:'平均导入至解决（秒）',format:v=>v===null||v===undefined?'—':Math.round(Number(v)).toString()}
    ],'暂无币种绩效数据');
    renderPerformanceTable('financeExceptionPerformanceAssignee',assignees,[
      {key:'username',label:'负责人',format:v=>v||'未分配'},{key:'currencyCode',label:'币种'},{key:'activeCount',label:'活跃异常'},
      {key:'overdueActiveCount',label:'超时异常'},{key:'overdueRatePercent',label:'超时率',format:performancePercent}
    ],'暂无负责人数据');
    renderPerformanceTable('financeExceptionPerformanceCategory',categories,[
      {key:'category',label:'异常类别'},{key:'currencyCode',label:'币种'},{key:'activeCount',label:'活跃异常'},
      {key:'overdueActiveCount',label:'超时异常'},{key:'overdueRatePercent',label:'超时率',format:performancePercent}
    ],'暂无异常分类数据');
  }
  function csvCell(value) {
    let text=String(value??'');
    if(/^[\\s\\u0000-\\u001f]*[=+@\\-]/.test(text))text="'"+text;
    return '"'+text.replace(/"/g,'""')+'"';
  }
  async function exportExceptionPerformance(slaHours) {
    const csv = await api('/admin/financial-reconciliation/exceptions/performance-export?slaHours=' + encodeURIComponent(String(slaHours)));
    if (typeof csv !== 'string' || !csv.startsWith('\uFEFF')) {
      throw new Error('服务端导出响应格式无效');
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'financial-exception-performance.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function loadExceptionPerformance(exportCsv=false) {
    if(!requirePermission())return;
    const target=$('#financeExceptionPerformanceSummary');if(target)target.innerHTML='<div class="empty-hint">正在加载异常绩效…</div>';
    const raw=Number($('#financeExceptionSlaHours')?.value||24),slaHours=Number.isSafeInteger(raw)&&raw>=1&&raw<=720?raw:24;
    try{const data=await api('/admin/financial-reconciliation/exceptions/performance-summary?slaHours='+encodeURIComponent(String(slaHours)));renderExceptionPerformance(data);if(exportCsv)await exportExceptionPerformance(slaHours);}
    catch(error){if(target)target.innerHTML='<div class="empty-hint">异常绩效加载失败</div>';toast('❌ '+(error.message||'异常绩效加载失败'));}
  }

  async function loadPerformanceExportAudit(append = false) {
    if (!requirePermission()) return;
    const target = $('#financePerformanceExportAudit');
    if (!target) return;
    if (!append) state.performanceExportAuditCursor = null;
    const query = new URLSearchParams({ limit: '25' });
    const actorId = $('#financePerformanceAuditActor')?.value.trim();
    const from = $('#financePerformanceAuditFrom')?.value;
    const to = $('#financePerformanceAuditTo')?.value;
    if (actorId) query.set('actorId', actorId);
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    if (append && state.performanceExportAuditCursor) query.set('afterId', String(state.performanceExportAuditCursor));
    try {
      const result = await api('/admin/financial-reconciliation/exceptions/performance-export-audit?' + query.toString());
      const rows = Array.isArray(result.items) ? result.items : [];
      const html = rows.map(row => '<tr><td>' + Number(row.id) + '</td><td>' + esc(row.createdAt || '—') +
        '</td><td>' + esc(row.actorUsername || '—') + '</td><td>' + Number(row.slaHours || 0) +
        '</td><td>' + Number(row.rowCount || 0) + '</td><td>' + esc(row.format || 'csv') + '</td></tr>').join('');
      const table = '<div style="overflow:auto;"><table style="width:100%;border-collapse:collapse;"><thead><tr>' +
        ['记录号','导出时间','操作人','SLA（小时）','导出行数','格式'].map(label => '<th style="text-align:left;padding:8px;">' + label + '</th>').join('') +
        '</tr></thead><tbody>' + html + '</tbody></table></div>';
      target.innerHTML = (append ? target.innerHTML.replace(/<div data-audit-more>[\\s\\S]*?<\\/div>$/, '') : '') +
        (rows.length ? table : (append ? '' : '<div class="empty-hint">暂无导出记录</div>')) +
        (result.nextCursor ? '<div data-audit-more style="margin-top:10px;"><button type="button" id="financePerformanceAuditMore" data-cursor="' + Number(result.nextCursor) + '">加载更多</button></div>' : '');
      state.performanceExportAuditCursor = result.nextCursor || null;
    } catch (error) {
      target.innerHTML = '<div class="empty-hint">导出审计记录加载失败</div>';
      toast('❌ ' + (error.message || '导出审计记录加载失败'));
    }
  }

  function bind() {
    const panel = root();
    if (!panel || panel.dataset.bound) return;
    panel.dataset.bound = '1';
    panel.addEventListener('click', event => {
      const batchButton = event.target.closest('[data-finance-batch]');
      if (batchButton) { loadBatchItems(batchButton.dataset.financeBatch, false); return; }
      const actionButton = event.target.closest('[data-finance-action]');
      if (actionButton) { submitReview(actionButton); return; }
      const historyMore = event.target.closest('[data-exception-history-more]');
      if (historyMore) { loadExceptionHistory(historyMore, true); return; }
      const historyButton = event.target.closest('[data-exception-history]');
      if (historyButton) {
        const historyTarget = $('#financeExceptionHistory-' + Number(historyButton.dataset.exceptionHistory));
        if (historyTarget) {
          if (historyTarget.hidden) {
            const key = String(historyButton.dataset.exceptionHistory);
            if (!state.exceptionHistory[key]?.loaded) loadExceptionHistory({ dataset: { item: key, batch: historyButton.dataset.batch } }, false);
            else historyTarget.hidden = false;
          } else historyTarget.hidden = true;
        }
        return;
      }
      const exceptionButton = event.target.closest('[data-exception-action]');
      if (exceptionButton) { submitExceptionAction(exceptionButton); return; }
      const alertHistory=event.target.closest('[data-sla-alert-history]');if(alertHistory){loadSlaAlertHistory(Number(alertHistory.dataset.slaAlertHistory));return;}
      const periodButton=event.target.closest('[data-finance-period]');if(periodButton){loadPeriodSummary(periodButton.dataset.financePeriod,true);return;}
      const alertAck=event.target.closest('[data-sla-alert-ack]');
      if(alertAck){acknowledgeSlaAlert(alertAck);return;}
      const alertDismiss=event.target.closest('[data-sla-alert-dismiss]');
      if(alertDismiss){dismissSlaAlert(alertDismiss);return;}
      const auditMore = event.target.closest('#financePerformanceAuditMore');\n      if (auditMore) { loadPerformanceExportAudit(true); return; }\n      const monthButton = event.target.closest('[data-month-close-action]');
      if (monthButton) submitMonthClose(monthButton);
    });
    $('#financeReloadBatches').addEventListener('click', () => loadBatches(false));
    $('#financeBatchMore').addEventListener('click', () => loadBatches(true));
    $('#financeRowsMore').addEventListener('click', () => loadBatchItems(state.batchId, true));
    $('#financeImportButton').addEventListener('click', importBatch);
    $('#financeReportRun').addEventListener('click', loadDailySummary);
    $('#financeExportDaily').addEventListener('click', () => loadDailySummary(true));
    $('#financeExceptionReload').addEventListener('click', () => loadExceptionQueue(false));
    $('#financeExceptionOpsReload').addEventListener('click', loadExceptionOperations);
    $('#financeExceptionPerformanceReload').addEventListener('click', () => loadExceptionPerformance());
    $('#financeExceptionPerformanceExport').addEventListener('click', () => loadExceptionPerformance(true));\n    $('#financePerformanceAuditReload')?.addEventListener('click', () => loadPerformanceExportAudit(false));
    $('#financeSlaAlertGenerate').addEventListener('click',generateSlaAlerts);
    $('#financeSlaAlertReload').addEventListener('click',loadSlaAlerts);
    $('#financeSlaAlertStatus')?.addEventListener('change',loadSlaAlerts);
    $('#financeReportLast7').addEventListener('click',()=>setReportRange('week'));
    $('#financeReportLast30').addEventListener('click',()=>setReportRange('month'));
    $('#financeReportThisMonth').addEventListener('click',()=>setReportRange('calendar-month'));
    $('#financeExceptionSlaHours').addEventListener('change', loadExceptionOperations);
    $('#financeExceptionMore').addEventListener('click', () => loadExceptionQueue(true));
    $('#financeExceptionCategory').addEventListener('change', () => loadExceptionQueue(false));
    $('#financeExceptionStatus').addEventListener('change', () => loadExceptionQueue(false));
    $('#financeCloseReload').addEventListener('click', loadMonthlyClose);
    $('#financeCloseMonth').addEventListener('change', loadMonthlyClose);
    $('#financeCloseCurrency').addEventListener('change', () => { state.monthCurrency = $('#financeCloseCurrency').value; loadMonthPeriod(); });
    $('#financeCloseHistoryMore').addEventListener('click', loadMonthHistory);
  }
  async function loadFinancialReconciliation() {
    if (!requirePermission()) return;
    bind();
    const today = dateValue(new Date());
    const from = $('#financeReportFrom');
    const to = $('#financeReportTo');
    if (from && !from.value) from.value = today;
    if (to && !to.value) to.value = today;
    await Promise.all([loadBatches(false), loadExceptionQueue(false), loadExceptionOperations(), loadExceptionPerformance(), loadPerformanceExportAudit(false), loadSlaAlerts(), loadDailySummary(), loadMonthlyClose()]);
  }
  window.loadFinancialReconciliation = loadFinancialReconciliation;
})();
