'use strict';

const { createFinancialReconciliationReviewService } = require('../server/services/financial-reconciliation-review');
const { createFinancialReconciliationService } = require('../server/services/financial-reconciliation');

function positiveRouteId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

module.exports = function(app, deps) {
  const { runAsync, getAsync, allAsync, withTransaction, requireAdminKey, requirePermission } = deps;
  const service = createFinancialReconciliationReviewService({ runAsync, getAsync, allAsync, withTransaction });
  const importService = createFinancialReconciliationService({ runAsync, getAsync, withTransaction });
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
      const status = error.code === 'RECONCILIATION_BATCH_CONFLICT' || error.code === 'RECONCILIATION_ROW_CONFLICT' ? 409 : 400;
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
         WHERE b.merchant_id=? AND b.store_id=? AND b.id>?
         ORDER BY b.id DESC LIMIT ?`,
        [context.merchantId, context.storeId, context.merchantId, context.storeId, afterValue, limitValue + 1]
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
        REVIEW_JOURNAL_NOT_FOUND: 404, REVIEW_JOURNAL_MISMATCH: 409
      })[error.code] || (error.code?.startsWith('REVIEW_') ? 400 : 500);
      res.status(status).json({ error: status >= 500 ? '财务审核操作失败，事务已回滚' : error.message });
    }
  });
};
