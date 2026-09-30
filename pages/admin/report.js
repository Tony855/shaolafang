/*
 * pages/admin/report.js — 报表 + 呼叫服务员模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc } = ctx;

// 格式化时间桶：把完整 ISO 时间戳压缩成人类可读的短字符串
function fmtTimeBucket(tb) {
  if (!tb) return '';
  const s = String(tb);
  // 完整 ISO（含 T）：只保留日期部分 YYYY-MM-DD
  if (s.includes('T')) return s.slice(0, 10);
  // YYYY-MM-DDTHH:mm 格式被截断成 HH:mm
  // 已经是 YYYY-MM / YYYY-MM-DD / HH:mm 等短格式，直接返回
  return s;
}

async function loadWaiterCalls() {
  try {
    const data = await api('/waiter-calls');
    const container = $('#waiterCallsList');
    if (!data || data.length === 0) {
      container.innerHTML = `<div style="text-align:center;padding:40px;color:#c8c8d0;">${tAdmin('noCalls')}</div>`;
      return;
    }
    container.innerHTML = data.map(c => {
      const isUrge = c.type === 'urge';
      const icon = isUrge ? '⚡' : '🔔';
      const label = isUrge ? (tAdmin('urgeOrder') || '催单') : (tAdmin('callWaiter') || '呼叫');
      const bg = isUrge ? 'rgba(231,76,60,.12)' : 'rgba(255,176,32,.1)';
      const border = isUrge ? 'rgba(231,76,60,.35)' : 'rgba(255,176,32,.3)';
      const btnBg = isUrge ? '#e74c3c' : '#ff7a45';
      return `
        <div style="background:${bg};border:1px solid ${border};border-radius:12px;padding:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">
            <div>
                <div style="font-weight:700;font-size:16px;color:#fff;">${icon} ${tAdmin('table')} ${esc(c.table_name)} ${label}</div>
                <div style="color:#b8b8c8;font-size:13px;margin-top:4px;">${esc(c.created_at)}${c.message ? ' · ' + esc(c.message) : ''}</div>
            </div>
            <button onclick="handleWaiterCall('${c.id}')" style="background:${btnBg};color:#fff;border:0;padding:8px 18px;border-radius:8px;cursor:pointer;font-weight:600;">${tAdmin('handled')}</button>
        </div>
    `;
    }).join('');
  } catch (err) {
    SLF.ui.toast(`${tAdmin('loadCallsFailed')}: ` + err.message);
  }
}

async function handleWaiterCall(id) {
  try {
    await api('/waiter-calls/' + id + '/handle', { method: 'PUT' });
    SLF.ui.toast(tAdmin('handled'));
    loadWaiterCalls();
  } catch (err) {
    SLF.ui.toast(tAdmin('handleFailed') + ': ' + err.message);
  }
}

async function loadDailyReport(rangeStart, rangeEnd) {
  // 若传入了范围参数，直接用；否则读取日期输入框（单日查询）
  let startDate, endDate;
  if (rangeStart && rangeEnd) {
    startDate = rangeStart;
    endDate = rangeEnd;
  } else {
    const _now = new Date();
    const _todayStr = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')}`;
    const dateInput = ($('#reportDate') && $('#reportDate').value) || _todayStr;
    startDate = endDate = dateInput;
  }
  try {
    const data = await api(`/admin/reports/daily?startDate=${startDate}&endDate=${endDate}`);
    const s = data.summary;
    const container = $('#reportContent');
    let html = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px;">
            <div style="background:rgba(255,255,255,.05);border-radius:12px;padding:16px;text-align:center;">
                <div style="font-size:28px;font-weight:700;color:#e85d3a;">${s.totalOrders}</div>
                <div style="color:#c8c8d0;font-size:13px;margin-top:4px;">${tAdmin('totalOrders')}</div>
            </div>
            <div style="background:rgba(255,255,255,.05);border-radius:12px;padding:16px;text-align:center;">
                <div style="font-size:28px;font-weight:700;color:#2ecc71;">${s.completedOrders}</div>
                <div style="color:#c8c8d0;font-size:13px;margin-top:4px;">${tAdmin('completed')}</div>
            </div>
            <div style="background:rgba(255,255,255,.05);border-radius:12px;padding:16px;text-align:center;">
                <div style="font-size:28px;font-weight:700;color:#e74c3c;">${s.canceledOrders}</div>
                <div style="color:#c8c8d0;font-size:13px;margin-top:4px;">${tAdmin('canceled')}</div>
            </div>
            <div style="background:rgba(255,255,255,.05);border-radius:12px;padding:16px;text-align:center;">
                <div style="font-size:28px;font-weight:700;color:#f1c40f;">$${Number(s.totalRevenue).toFixed(2)}</div>
                <div style="color:#c8c8d0;font-size:13px;margin-top:4px;">${tAdmin('totalRevenue')}</div>
            </div>
            <div style="background:rgba(255,255,255,.05);border-radius:12px;padding:16px;text-align:center;">
                <div style="font-size:28px;font-weight:700;color:#3498db;">$${Number(s.avgOrderValue).toFixed(2)}</div>
                <div style="color:#c8c8d0;font-size:13px;margin-top:4px;">${tAdmin('avgOrderValue')}</div>
            </div>
        </div>
    `;
    if (data.hourlyStats && data.hourlyStats.length > 0) {
      // 根据粒度显示不同的标题
      const granLabel = data.granularity === 'year' ? '📅' : data.granularity === 'month' ? '📆' : '⏰';
      html += `<h3 style="margin:20px 0 10px;color:#fff;font-size:15px;font-weight:700;">${granLabel} ${tAdmin('hourlyDistribution')} <span style="font-size:12px;color:#888;font-weight:400;">(${data.date})</span></h3><div style="background:rgba(255,255,255,.05);border-radius:12px;padding:14px;">`;
      const maxOrders = Math.max(...data.hourlyStats.map(h => h.orders), 1);
      for (const h of data.hourlyStats) {
        const pct = (h.orders / maxOrders * 100).toFixed(0);
        html += `<div style="display:flex;align-items:center;gap:10px;margin:6px 0;"><span style="width:88px;color:#c8c8d0;font-size:13px;text-align:right;">${fmtTimeBucket(h.time_bucket)}</span><div style="flex:1;background:rgba(255,255,255,.1);border-radius:6px;height:20px;overflow:hidden;"><div style="width:${pct}%;background:linear-gradient(90deg,#e85d3a,#f39c12);height:100%;border-radius:6px;"></div></div><span style="width:70px;text-align:right;font-size:13px;color:#fff;font-weight:600;">${h.orders}${tAdmin('orderUnit')} $${Number(h.revenue).toFixed(0)}</span></div>`;
      }
      html += `</div>`;
    }
    if (data.tableRevenue && data.tableRevenue.length > 0) {
      html += `<h3 style="margin:20px 0 10px;color:#fff;font-size:15px;font-weight:700;">🏪 ${tAdmin('revenueByTable')}</h3><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px;">`;
      for (const t of data.tableRevenue) {
        html += `<div style="background:linear-gradient(135deg,rgba(255,255,255,.07),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:14px;text-align:center;"><div style="font-weight:700;color:#fff;font-size:15px;">${esc(t.table_name)}</div><div style="color:#2ecc71;font-size:20px;font-weight:700;margin-top:6px;">$${Number(t.revenue).toFixed(2)}</div><div style="color:#c8c8d0;font-size:12px;margin-top:2px;">${t.orders} ${tAdmin('orderUnit')}</div></div>`;
      }
      html += `</div>`;
    }
    if (data.dishRanking && data.dishRanking.length > 0) {
      html += `<h3 style="margin:20px 0 10px;color:#fff;font-size:15px;font-weight:700;">🔥 ${tAdmin('topDishes')}</h3><div style="background:rgba(255,255,255,.05);border-radius:12px;padding:14px;margin-bottom:20px;">`;
      data.dishRanking.forEach((d, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        html += `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06);align-items:center;"><span style="color:#fff;font-weight:600;font-size:14px;">${medal} ${d.emoji || ''} ${esc(d.name)}</span><span style="font-weight:700;color:#ffd93d;font-size:14px;">${d.quantity || 0} ${tAdmin('portion')}</span></div>`;
      });
      html += `</div>`;
    }
    container.innerHTML = html;
  } catch (err) { SLF.ui.toast(`${tAdmin('loadReportFailed')}: ` + err.message); }
}

function exportData(type) {
  const adminTokenLocal = SLF.store.rawGetSession('adminToken') || '';
  const url = '/api/admin/export/' + type;
  fetch(url, { headers: { 'Authorization': 'Bearer ' + adminTokenLocal } })
    .then(res => {
      if (!res.ok) throw new Error(tAdmin('exportFailed'));
      return res.blob();
    })
    .then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = type + '_' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      URL.revokeObjectURL(a.href);
      SLF.ui.toast(tAdmin('exportSuccess'));
    })
    .catch(err => SLF.ui.toast(tAdmin('exportFailed') + ': ' + err.message));
}

// 挂到 window
window.loadWaiterCalls = loadWaiterCalls;
window.handleWaiterCall = handleWaiterCall;
window.loadDailyReport = loadDailyReport;
window.exportData = exportData;


// ===== 2026-09-29 快捷日期范围 =====
(function initQuickRange() {
  // 本地时间格式化（避免 toISOString 的 UTC 偏移问题）
  const fmtLocal = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const applyRange = (type) => {
    const today = new Date();
    const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
    let start, end;
    if (type === 'today') {
      start = end = fmtLocal(new Date(y, m, d));
    } else if (type === 'week') {
      const mon = new Date(y, m, d - ((today.getDay() + 6) % 7));
      const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
      start = fmtLocal(mon); end = fmtLocal(sun);
    } else if (type === 'month') {
      start = fmtLocal(new Date(y, m, 1));
      end = fmtLocal(new Date(y, m + 1, 0));
    } else if (type === 'year') {
      start = fmtLocal(new Date(y, 0, 1));
      end = fmtLocal(new Date(y, 11, 31));
    }
    // 更新日期输入框为起始日
    const dateEl = document.getElementById('reportDate');
    if (dateEl) dateEl.value = start;
    if (typeof loadDailyReport === 'function') loadDailyReport(start, end);
  };

  const initUI = () => {
    // 默认值（用本地日期）
    const dateEl = document.getElementById('reportDate');
    if (dateEl && !dateEl.value) dateEl.value = fmtLocal(new Date());

    // 快捷按钮
    document.querySelectorAll('[data-range]').forEach(btn => {
      btn.onclick = () => applyRange(btn.dataset.range);
    });

    // 语言切换后刷新标签
    if (SLF.i18n && typeof SLF.i18n.onChange === 'function') {
      SLF.i18n.onChange(() => applyReportLabels());
    }
    applyReportLabels();
  };

  // 立即执行（无论 DOM 是否已就绪，因为本模块可能在 DOMContentLoaded 之后才加载）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }

  function applyReportLabels() {
    if (typeof tAdmin !== 'function') return;
    const setText = (id, key) => {
      const el = document.getElementById(id);
      if (el) el.textContent = tAdmin(key);
    };
    setText('quickTodayBtn', 'quickToday');
    setText('quickWeekBtn', 'quickWeek');
    setText('quickMonthBtn', 'quickMonth');
    setText('quickYearBtn', 'quickYear');
    setText('reportDateLabel', 'date');
  }

// ═══════════════════════════════════════════════════════════
// 高级导出弹窗（2026-10-01）
// ═══════════════════════════════════════════════════════════
function openAdvancedExport() {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    document.getElementById('advExportStart').value = weekAgo;
    document.getElementById('advExportEnd').value = today;
    document.getElementById('advancedExportModal').style.display = 'flex';
}

function closeAdvancedExport() {
    document.getElementById('advancedExportModal').style.display = 'none';
}

async function doAdvancedExport() {
    const start = document.getElementById('advExportStart').value;
    const end = document.getElementById('advExportEnd').value;
    const dim = document.getElementById('advExportDim').value;
    const statuses = Array.from(document.querySelectorAll('.adv-status:checked'))
        .map(cb => cb.value).join(',');

    if (!start || !end) { SLF.ui.toast('❌ 请选择日期范围'); return; }
    if (!statuses) { SLF.ui.toast('❌ 请至少选择一个状态'); return; }

    const params = new URLSearchParams({ startDate: start, endDate: end, dimension: dim, statuses });
    const token = SLF.store.rawGetSession('adminToken') || '';
    const storeId = SLF.store.rawGetSession('adminStoreId') || SLF.store.rawGet('storeId') || '1';

    try {
        const res = await fetch('/api/admin/export-advanced?' + params.toString(), {
            headers: {
                'Authorization': 'Bearer ' + token,
                'X-Store-Id': String(storeId)
            }
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || 'HTTP ' + res.status);
        }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${dim}_${start}_${end}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        SLF.ui.toast('✅ 已导出');
        closeAdvancedExport();
    } catch (e) {
        SLF.ui.toast('❌ 导出失败: ' + e.message);
    }
}

window.openAdvancedExport = openAdvancedExport;
window.closeAdvancedExport = closeAdvancedExport;
window.doAdvancedExport = doAdvancedExport;

})();
})();

// ═══════════════════════════════════════════════════════════
// advExportBtn 事件委托（2026-10-01）
// 挂在 document 捕获阶段，不管按钮怎么被 i18n 重建都能命中
// ═══════════════════════════════════════════════════════════
(function delegateAdvExport() {
    document.addEventListener('click', function (e) {
        // 捕获阶段先判断
        const btn = e.target && e.target.closest && e.target.closest('#advExportBtn');
        if (!btn) return;

        // 拦掉其它所有监听（包括 i18n 后重绑的导出 handler）
        e.preventDefault();
        e.stopImmediatePropagation();

        // 打开弹窗
        try {
            if (typeof window.openAdvancedExport === 'function') {
                window.openAdvancedExport();
            } else if (typeof openAdvancedExport === 'function') {
                openAdvancedExport();
            } else {
                console.error('[delegateAdvExport] openAdvancedExport 未定义');
            }
        } catch (err) {
            console.error('[delegateAdvExport] 打开弹窗失败:', err);
        }
        return false;
    }, true);   // ← true = 捕获阶段，先于一切其他监听
})();
