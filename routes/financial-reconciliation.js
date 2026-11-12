'use strict';

const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');
const { createFinancialReconciliationService } = require('../server/services/financial-reconciliation');
const { createFinancialVoucherExportService } = require('../server/services/financial-voucher-export');
const { createFinancialMonthCloseService } = require('../server/services/financial-month-close');
const { lockOpenFinancialMonthPeriod } = require('../server/db/migrations/financial-month-close');

function positiveRouteId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

module.exports = function(app, deps) {
  const { runAsync, getAsync, allAsync, withTransaction, requireAdminKey, requirePermission } = deps;
  const lockImportMonth = async ({ merchantId, storeId, currencyCode, providerCode, externalBatchId }) => {
    const existingBatch = await getAsync(
      "SELECT DATE_FORMAT(imported_at, '%Y-%m') AS period_month FROM financial_reconciliation_batches WHERE merchant_id=? AND store_id=? AND provider_code=? AND external_batch_id=?",
      [merchantId, storeId, providerCode, externalBatchId]
    );
    const currentMonth = existingBatch ? existingBatch : await getAsync(
      "SELECT DATE_FORMAT(CURRENT_TIMESTAMP(3), '%Y-%m') AS period_month"
    );
    return lockOpenFinancialMonthPeriod({
      runAsync, getAsync, merchantId, storeId,
      periodMonth: currentMonth?.period_month, currencyCode
    });
  };
  const lockReviewMonth = async ({ merchantId, storeId, batchId }) => {
    const batchScope = await getAsync(
      "SELECT id, currency_code, DATE_FORMAT(imported_at, '%Y-%m') AS period_month FROM financial_reconciliation_batches WHERE id=? AND merchant_id=? AND store_id=?",
      [batchId, merchantId, storeId]
    );
    if (!batchScope) {
      const error = new Error('reconciliation batch not found');
      error.code = 'REVIEW_NOT_FOUND';
      throw error;
    }
    return lockOpenFinancialMonthPeriod({
      runAsync, getAsync, merchantId, storeId,
      periodMonth: batchScope.period_month, currencyCode: batchScope.currency_code
    });
  };
  const service = createFinancialReconciliationReviewService({
    runAsync, getAsync, allAsync, withTransaction, lockFinancialMonthPeriod: lockReviewMonth
  });
  const importService = createFinancialReconciliationService({
    runAsync, getAsync, withTransaction, lockFinancialMonthPeriod: lockImportMonth
  });
  const voucherExportService = createFinancialVoucherExportService({ allAsync, withTransaction });
  const monthCloseService = createFinancialMonthCloseService({ runAsync, getAsync, allAsync, withTransaction });
  const financeAuth = [requireAdminKey, requirePermission('can_manage_financial_reconciliation')];

  function tenantContext(req, res) {
    const merchantId = positiveRouteId(req.merchantId);
    const storeId = positiveRouteId(req.storeId);
    const actorId = positiveRouteId(req.adminId);
    if (!merchantId || !storeId || !actorId) {
      res.status(403).json({ error: '财务审核需要有效的商户、门店和管理员身份' });
      return null;
    }
    return { merchantId, storeId, actorId };
  }

  app.post('/api/admin/financial-reconciliation/batches/import', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    const body = req.body || {};
    try {
      const result = await importService.importStatementBatch({
        ...context, providerCode: body.providerCode, externalBatchId: body.externalBatchId,
        statementSha256: body.statementSha256, currencyCode: body.currencyCode, rows: body.rows
      });
      res.status(result.replayed ? 200 : 201).json({ success: true, ...result });
    } catch (error) {
      const status = error.code === 'RECONCILIATION_BATCH_CONFLICT' || error.code === 'RECONCILIATION_ROW_CONFLICT' || error.code === 'FINANCIAL_MONTH_LOCKED' ? 409 : 400;
      res.status(status).json({ error: status === 409 ? '相同对账批次编号已对应不同内容' : '对账流水格式无效或导入失败' });
    }
  });
  app.get('/api/admin/financial-reconciliation/batches', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    const limitValue = Number(req.query.limit || 30);
    const afterValue = req.query.afterId === undefined ? 0 : Number(req.query.afterId);
    if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 100 ||
        !Number.isSafeInteger(afterValue) || afterValue < 0) {
      return res.status(400).json({ error: '对账批次分页参数无效' });
    }
    try {
      const rows = await allAsync(
        `SELECT b.id, b.provider_code, b.external_batch_id, b.currency_code, b.row_count,
                b.total_debit_minor, b.total_credit_minor, b.status, b.imported_at,
                COALESCE(i.matched_count, 0) AS matched_count,
                COALESCE(i.pending_count, 0) AS pending_count,
                COALESCE(i.unmatched_count, 0) AS unmatched_count,
                COALESCE(i.ambiguous_count, 0) AS ambiguous_count,
                COALESCE(i.exception_count, 0) AS exception_count
         FROM financial_reconciliation_batches b
         LEFT JOIN (
           SELECT batch_id, merchant_id, store_id,
                  SUM(match_status='matched') AS matched_count,
                  SUM(match_status='pending') AS pending_count,
                  SUM(match_status='unmatched') AS unmatched_count,
                  SUM(match_status='ambiguous') AS ambiguous_count,
                  SUM(match_status='exception') AS exception_count
           FROM financial_reconciliation_items
           WHERE merchant_id=? AND store_id=?
           GROUP BY batch_id, merchant_id, store_id
         ) i ON i.batch_id=b.id AND i.merchant_id=b.merchant_id AND i.store_id=b.store_id
         WHERE b.merchant_id=? AND b.store_id=? AND (?=0 OR b.id<?)
         ORDER BY b.id DESC LIMIT ?`,
        [context.merchantId, context.storeId, context.merchantId, context.storeId, afterValue, afterValue || Number.MAX_SAFE_INTEGER, limitValue + 1]
      );
      const hasMore = rows.length > limitValue;
      if (hasMore) rows.pop();
      res.setHeader('Cache-Control', 'no-store, private');
      res.json({
        rows,
        nextCursor: hasMore && rows.length ? Number(rows[rows.length - 1].id) : null
      });
    } catch (_) {
      res.status(500).json({ error: '获取对账批次列表失败' });
    }
  });

  app.get('/api/admin/financial-reconciliation/batches/:batchId/items', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    const batchId = positiveRouteId(req.params.batchId);
    if (!batchId) return res.status(400).json({ error: '对账批次编号无效' });
    try {
      const result = await service.listBatchReview({ ...context, batchId, limit: req.query.limit || 500, afterRowNo: req.query.afterRowNo || 0 });
      if (!result) return res.status(404).json({ error: '对账批次不存在' });
      res.setHeader('Cache-Control', 'no-store, private');
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.code ? '对账数据或匹配候选无效' : '获取对账审核列表失败' });
    }
  });

  app.get('/api/admin/financial-reconciliation/review-history', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    const limit = Number(req.query.limit || 50);
    const afterId = req.query.afterId === undefined ? 0 : Number(req.query.afterId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
        !Number.isSafeInteger(afterId) || afterId < 0) {
      return res.status(400).json({ error: '审核历史分页参数无效' });
    }
    try {
      const result = await service.listReviewHistory({
        ...context, batchId: req.query.batchId, itemId: req.query.itemId, limit, afterId
      });
      res.setHeader('Cache-Control', 'no-store, private');
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: '审核历史查询参数无效' });
    }
  });

  app.get('/api/admin/financial-reconciliation/journal-export', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    try {
      const result = await voucherExportService.exportJournalDetails({
        ...context, from: req.query.from, to: req.query.to
      });
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="financial-journal-' + result.from + '-to-' + result.to + '.csv"');
      res.status(200).send(result.csv);
    } catch (error) {
      const status = error.code === 'VOUCHER_EXPORT_DATE_RANGE_INVALID' ? 400
        : error.code === 'VOUCHER_EXPORT_TOO_LARGE' ? 413 : 500;
      res.status(status).json({
        error: status === 400 ? '导出日期范围无效（最多 31 天）'
          : status === 413 ? '导出记录超过 5000 行，请缩小日期范围'
            : '财务明细导出失败'
      });
    }
  });

  app.get('/api/admin/financial-reconciliation/month-close/period', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    try {
      const period = await monthCloseService.getPeriod({
        ...context, month: req.query.month, currencyCode: req.query.currencyCode
      });
      res.setHeader('Cache-Control', 'no-store, private');
      res.json({ period });
    } catch (error) {
      res.status(error.code === 'MONTH_CLOSE_MONTH_INVALID' || error.code === 'MONTH_CLOSE_CURRENCY_INVALID' ? 400 : 500)
        .json({ error: error.code ? '月结期间查询参数无效' : '获取月结状态失败' });
    }
  });

  app.get('/api/admin/financial-reconciliation/month-close/history', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    try {
      const result = await monthCloseService.listHistory({
        ...context, month: req.query.month, currencyCode: req.query.currencyCode,
        limit: req.query.limit || 50, afterId: req.query.afterId || 0
      });
      res.setHeader('Cache-Control', 'no-store, private');
      res.json(result);
    } catch (error) {
      res.status(error.code === 'MONTH_CLOSE_PAGINATION_INVALID' || error.code === 'MONTH_CLOSE_MONTH_INVALID' ||
        error.code === 'MONTH_CLOSE_CURRENCY_INVALID' ? 400 : 500)
        .json({ error: '月结审批历史查询参数无效' });
    }
  });

  app.post('/api/admin/financial-reconciliation/month-close/transition', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    try {
      const actor = await getAsync(
        'SELECT username FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1',
        [context.actorId, context.merchantId]
      );
      if (!actor) return res.status(403).json({ error: '财务审核账号无效或已停用' });
      const result = await monthCloseService.transition({
        ...context, actorUsername: actor.username,
        month: req.body?.month, currencyCode: req.body?.currencyCode,
        action: req.body?.action, reason: req.body?.reason,
        idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey
      });
      res.status(result.replayed ? 200 : 201).json({ success: true, ...result });
    } catch (error) {
      const status = ({
        MONTH_CLOSE_NOT_READY: 409,
        MONTH_CLOSE_STATE_CONFLICT: 409,
        MONTH_CLOSE_IDEMPOTENCY_CONFLICT: 409,
        MONTH_CLOSE_MAKER_CHECKER_REQUIRED: 403
      })[error.code] || (error.code?.startsWith('MONTH_CLOSE_') ? 400 : 500);
      res.status(status).json({
        error: status >= 500 ? '月结审批操作失败，事务已回滚'
          : error.code === 'MONTH_CLOSE_NOT_READY' ? '该月份仍有未完成对账项目，不能申请关账'
            : error.code === 'MONTH_CLOSE_MAKER_CHECKER_REQUIRED' ? '申请人不能审批或拒绝自己的申请'
              : error.message
      });
    }
  });

  app.get('/api/admin/financial-reconciliation/monthly-close-preview', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    try {
      const rows = await service.getMonthlyClosePreview({ ...context, month: req.query.month });
      res.setHeader('Cache-Control', 'no-store, private');
      res.json({ month: req.query.month, rows });
    } catch (error) {
      res.status(error.code === 'REVIEW_MONTH_INVALID' ? 400 : 500)
        .json({ error: error.code === 'REVIEW_MONTH_INVALID' ? '月份格式无效（YYYY-MM）' : '获取月结准备报告失败' });
    }
  });

  app.get('/api/admin/financial-reconciliation/daily-summary', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    try {
      const rows = await service.getDailySummary({ ...context, from: req.query.from, to: req.query.to });
      res.setHeader('Cache-Control', 'no-store, private');
      res.json({ rows });
    } catch (error) {
      res.status(error.code === 'REVIEW_DATE_RANGE_INVALID' ? 400 : 500)
        .json({ error: error.code === 'REVIEW_DATE_RANGE_INVALID' ? '日期范围无效（最多 91 天）' : '获取每日对账汇总失败' });
    }
  });


  app.post('/api/admin/financial-reconciliation/exceptions/alerts/generate', ...financeAuth, async (req, res) => {
    const context=tenantContext(req,res);if(!context)return;
    const slaHours=req.body?.slaHours===undefined?24:Number(req.body.slaHours);
    if(!Number.isSafeInteger(slaHours)||slaHours<1||slaHours>720)return res.status(400).json({error:'SLA 小时数必须为 1–720 的整数'});
    try{
      const actor=await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1',[context.actorId,context.merchantId]);
      if(!actor)return res.status(403).json({error:'财务审核账号无效或已停用'});
      const result=await service.generateSlaAlerts({...context,slaHours,actorId:context.actorId,actorUsername:actor.username});
      res.setHeader('Cache-Control','no-store, private');res.status(201).json({success:true,...result});
    }catch(error){res.status(error.code==='EXCEPTION_ALERT_SLA_INVALID'?400:500).json({error:error.code?'SLA 提醒生成参数无效':'生成 SLA 提醒失败'});}
  });
  app.get('/api/admin/financial-reconciliation/exceptions/alerts', ...financeAuth, async (req,res)=>{
    const context=tenantContext(req,res);if(!context)return;
    try{
      const result=await service.listSlaAlerts({...context,status:req.query.status||'pending',limit:req.query.limit||50,afterId:req.query.afterId||0});
      res.setHeader('Cache-Control','no-store, private');res.json(result);
    }catch(error){
      const status=['EXCEPTION_ALERT_PAGINATION_INVALID','EXCEPTION_ALERT_FILTER_INVALID'].includes(error.code)?400:500;
      res.status(status).json({error:status===400?'SLA 提醒筛选或分页参数无效':'获取 SLA 提醒失败'});
    }
  });
  app.post('/api/admin/financial-reconciliation/exceptions/alerts/:alertId/acknowledge', ...financeAuth, async (req,res)=>{
    const context=tenantContext(req,res);if(!context)return;
    const alertId=positiveRouteId(req.params.alertId);if(!alertId)return res.status(400).json({error:'提醒编号无效'});
    try{
      const actor=await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1',[context.actorId,context.merchantId]);
      if(!actor)return res.status(403).json({error:'财务审核账号无效或已停用'});
      const result=await service.acknowledgeSlaAlert({...context,alertId,actorUsername:actor.username,reason:req.body?.reason,idempotencyKey:req.get('Idempotency-Key')||req.body?.idempotencyKey});
      res.status(result.replayed?200:201).json({success:true,...result});
    }catch(error){
      const status=({EXCEPTION_ALERT_NOT_FOUND:404,EXCEPTION_ALERT_STATE_CONFLICT:409,EXCEPTION_ALERT_IDEMPOTENCY_CONFLICT:409,EXCEPTION_ALERT_IDEMPOTENCY_INVALID:400})[error.code]||(error.code?.startsWith('EXCEPTION_ALERT_')?400:500);
      res.status(status).json({error:status>=500?'确认 SLA 提醒失败，事务已回滚':error.message});
    }
  });

  app.post('/api/admin/financial-reconciliation/exceptions/alerts/:alertId/dismiss', ...financeAuth, async (req,res)=>{
    const context=tenantContext(req,res);if(!context)return;
    const alertId=positiveRouteId(req.params.alertId);if(!alertId)return res.status(400).json({error:'提醒编号无效'});
    try{
      const actor=await getAsync('SELECT username FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1',[context.actorId,context.merchantId]);
      if(!actor)return res.status(403).json({error:'财务审核账号无效或已停用'});
      const result=await service.dismissSlaAlert({...context,alertId,actorUsername:actor.username,reason:req.body?.reason,idempotencyKey:req.get('Idempotency-Key')||req.body?.idempotencyKey});
      res.setHeader('Cache-Control','no-store, private');res.status(result.replayed?200:201).json({success:true,...result});
    }catch(error){
      const status=({EXCEPTION_ALERT_NOT_FOUND:404,EXCEPTION_ALERT_STATE_CONFLICT:409,EXCEPTION_ALERT_IDEMPOTENCY_CONFLICT:409,EXCEPTION_ALERT_IDEMPOTENCY_INVALID:400})[error.code]||(error.code?.startsWith('EXCEPTION_ALERT_')?400:500);
      res.status(status).json({error:status>=500?'关闭 SLA 提醒失败，事务已回滚':error.message});
    }
  });

  app.get('/api/admin/financial-reconciliation/exceptions/operations-summary', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    const slaHours = req.query.slaHours === undefined ? 24 : Number(req.query.slaHours);
    if (!Number.isSafeInteger(slaHours) || slaHours < 1 || slaHours > 720) {
      return res.status(400).json({ error: 'SLA 小时数必须为 1–720 的整数' });
    }
    try {
      const result = await service.getExceptionOperationsSummary({ ...context, slaHours });
      res.setHeader('Cache-Control', 'no-store, private');
      res.json(result);
    } catch (error) {
      res.status(error.code === 'EXCEPTION_OPERATIONS_SLA_INVALID' ? 400 : 500)
        .json({ error: error.code ? '异常运营统计参数无效' : '获取异常运营统计失败' });
    }
  });

  app.get('/api/admin/financial-reconciliation/exceptions', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    try {
      const result = await service.listExceptions({
        ...context, category: req.query.category, caseStatus: req.query.status, from: req.query.from, to: req.query.to,
        limit: req.query.limit || 50, afterId: req.query.afterId || 0
      });
      res.setHeader('Cache-Control', 'no-store, private');
      res.json(result);
    } catch (error) {
      const status = error.code === 'REVIEW_EXCEPTION_PAGINATION_INVALID' ||
        error.code === 'REVIEW_EXCEPTION_FILTER_INVALID' ||
        error.code === 'REVIEW_EXCEPTION_DATE_RANGE_INVALID' ? 400 : 500;
      res.status(status).json({ error: status === 400 ? '财务异常筛选或分页参数无效' : '获取财务异常队列失败' });
    }
  });



  app.get('/api/admin/financial-reconciliation/exceptions/:itemId/history', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    const itemId = positiveRouteId(req.params.itemId);
    const batchId = positiveRouteId(req.query.batchId);
    const limit = Number(req.query.limit || 50);
    const afterId = req.query.afterId === undefined ? 0 : Number(req.query.afterId);
    if (!itemId || !batchId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(afterId) || afterId < 0) {
      return res.status(400).json({ error: '财务异常审计历史分页参数无效' });
    }
    try {
      const result = await service.listExceptionHistory({ ...context, itemId, batchId, limit, afterId });
      res.setHeader('Cache-Control', 'no-store, private');
      res.json(result);
    } catch (error) {
      const status = error.code === 'EXCEPTION_WORKFLOW_NOT_FOUND' ? 404 : 400;
      res.status(status).json({ error: status === 404 ? '财务异常不存在' : '财务异常审计历史查询失败' });
    }
  });

  app.post('/api/admin/financial-reconciliation/exceptions/:itemId/workflow', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    const itemId = positiveRouteId(req.params.itemId);
    const batchId = positiveRouteId(req.body?.batchId);
    if (!itemId || !batchId) return res.status(400).json({ error: '财务异常或批次编号无效' });
    try {
      const actor = await getAsync(
        'SELECT username FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1',
        [context.actorId, context.merchantId]
      );
      if (!actor) return res.status(403).json({ error: '财务审核账号无效或已停用' });
      const result = await service.transitionExceptionCase({
        ...context, itemId, batchId, actorUsername: actor.username,
        action: req.body?.action, assignedAdminId: req.body?.assignedAdminId,
        reason: req.body?.reason, idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey
      });
      res.status(result.replayed ? 200 : 201).json({ success: true, ...result });
    } catch (error) {
      const status = ({
        EXCEPTION_WORKFLOW_NOT_FOUND: 404, EXCEPTION_WORKFLOW_BATCH_CLOSED: 409,
        EXCEPTION_WORKFLOW_STATE_CONFLICT: 409, EXCEPTION_WORKFLOW_IDEMPOTENCY_CONFLICT: 409,
        EXCEPTION_WORKFLOW_ASSIGNEE_INVALID: 400
      })[error.code] || (error.code?.startsWith('EXCEPTION_WORKFLOW_') ? 400 : 500);
      res.status(status).json({
        error: status >= 500 ? '财务异常处理失败，事务已回滚' : error.message
      });
    }
  });

  app.post('/api/admin/financial-reconciliation/items/:itemId/review', ...financeAuth, async (req, res) => {
    const context = tenantContext(req, res);
    if (!context) return;
    const itemId = positiveRouteId(req.params.itemId);
    const batchId = positiveRouteId(req.body?.batchId);
    if (!itemId || !batchId) return res.status(400).json({ error: '对账项目或批次编号无效' });
    try {
      const actor = await getAsync(
        'SELECT username FROM merchant_admins WHERE id=? AND merchant_id=? AND active=1',
        [context.actorId, context.merchantId]
      );
      if (!actor) return res.status(403).json({ error: '财务审核账号无效或已停用' });
      const result = await service.reviewItem({
        ...context, itemId, batchId, actorUsername: actor.username,
        action: req.body?.action, exceptionCategory: req.body?.exceptionCategory, journalTransactionId: req.body?.journalTransactionId,
        reason: req.body?.reason, idempotencyKey: req.get('Idempotency-Key') || req.body?.idempotencyKey
      });
      res.status(result.replayed ? 200 : 201).json({ success: true, ...result });
    } catch (error) {
      const status = ({
        REVIEW_NOT_FOUND: 404, REVIEW_BATCH_CLOSED: 409, REVIEW_STATE_CONFLICT: 409,
        REVIEW_DUPLICATE_ASSIGNMENT: 409, REVIEW_IDEMPOTENCY_CONFLICT: 409,
        REVIEW_JOURNAL_NOT_FOUND: 404, REVIEW_JOURNAL_MISMATCH: 409, FINANCIAL_MONTH_LOCKED: 409
      })[error.code] || (error.code?.startsWith('REVIEW_') ? 400 : 500);
      res.status(status).json({ error: status >= 500 ? '财务审核操作失败，事务已回滚' : error.message });
    }
  });
};
