/* ============================================================
   routes/admin-reports.js — 报表 + 管理员信息
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync, requireAdminKey, authenticateAdmin } = deps;

  // 根据 scope 生成 store 过滤条件
  // 返回 { where, params, isAll }
  function buildStoreWhere(req, scope) {
    if (scope === 'all') {
      return {
        where: 'store_id IN (SELECT id FROM stores WHERE merchant_id=?)',
        params: [req.merchantId],
        isAll: true
      };
    }
    return {
      where: 'store_id=?',
      params: [req.storeId],
      isAll: false
    };
  }


  app.get('/api/admin/reports/daily', requireAdminKey, async (req, res) => {
    try {
      // ===== 支持 startDate/endDate 范围查询，向后兼容 date =====
      let startDate = req.query.startDate || req.query.date || new Date().toISOString().slice(0, 10);
      let endDate = req.query.endDate || startDate;

      const scope = String(req.query.scope || 'current').toLowerCase();
      const sw = buildStoreWhere(req, scope);
      const swWhere = sw.where;
      const swParams = sw.params;
      const isAll = sw.isAll;

      const startOfDay = new Date(startDate + 'T00:00:00.000Z');
      const endOfDay = new Date(endDate + 'T23:59:59.999Z');
      const date = (startDate === endDate) ? startDate : `${startDate} ~ ${endDate}`;

      // 根据范围天数自动判断聚合粒度
      const daysDiff = Math.max(1, Math.round((endOfDay - startOfDay) / 86400000) + 1);
      let granularity;
      if (daysDiff <= 1) granularity = 'day';
      else if (daysDiff <= 31) granularity = 'month';   // 按天聚合
      else granularity = 'year';                        // 按月聚合
      const rangeStart = startOfDay.toISOString();
      const rangeEnd = endOfDay.toISOString();
      const orderStats = await getAsync(`
        SELECT
          (SELECT COUNT(*) FROM orders WHERE ${swWhere} AND createdAt >= ? AND createdAt <= ?) AS total_orders,
          (SELECT COUNT(*) FROM orders WHERE ${swWhere} AND status='done' AND COALESCE(settled_at, createdAt) >= ? AND COALESCE(settled_at, createdAt) <= ?) AS completed_orders,
          (SELECT COUNT(*) FROM orders WHERE ${swWhere} AND status='canceled' AND createdAt >= ? AND createdAt <= ?) AS canceled_orders,
          (SELECT COALESCE(SUM(total), 0) FROM orders WHERE ${swWhere} AND status='done' AND COALESCE(settled_at, createdAt) >= ? AND COALESCE(settled_at, createdAt) <= ?) AS total_revenue,
          (SELECT AVG(total) FROM orders WHERE ${swWhere} AND status='done' AND COALESCE(settled_at, createdAt) >= ? AND COALESCE(settled_at, createdAt) <= ?) AS avg_order_value
      `, [
        ...swParams, rangeStart, rangeEnd,
        ...swParams, rangeStart, rangeEnd,
        ...swParams, rangeStart, rangeEnd,
        ...swParams, rangeStart, rangeEnd,
        ...swParams, rangeStart, rangeEnd
      ]);
      const tableRevenue = await allAsync(`
        SELECT table_name, COUNT(*) AS orders, SUM(total) AS revenue
        FROM orders
        WHERE ${swWhere} AND status='done' AND COALESCE(settled_at, createdAt) >= ? AND COALESCE(settled_at, createdAt) <= ?
        GROUP BY table_name
        ORDER BY revenue DESC
      `, [...swParams, startOfDay.toISOString(), endOfDay.toISOString()]);
      const dishRanking = await allAsync(`
        SELECT m.name, m.emoji,
               SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS UNSIGNED)
                 - COALESCE(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].returnedQty')) AS UNSIGNED), 0)) AS quantity
        FROM orders o
        JOIN (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) n
          ON JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) IS NOT NULL
        JOIN menus m ON m.id = CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) AS UNSIGNED)
        WHERE o.${swWhere.replace(/store_id/g, 'store_id')} AND o.status='done' AND COALESCE(o.settled_at, o.createdAt) >= ? AND COALESCE(o.settled_at, o.createdAt) <= ?
        GROUP BY m.id, m.name, m.emoji
        HAVING quantity > 0
        ORDER BY quantity DESC
        LIMIT 10
      `, [...swParams, startOfDay.toISOString(), endOfDay.toISOString()]);
      // ===== 时段分布：按粒度动态调整 =====
      let hourlyStats;
      if (granularity === 'day') {
        // 按日：24 小时内每 10 分钟聚合
        hourlyStats = await allAsync(`
          SELECT CONCAT(LPAD(HOUR(COALESCE(settled_at, createdAt)),2,'0'), ':', LPAD(FLOOR(MINUTE(COALESCE(settled_at, createdAt))/10)*10, 2, '0')) AS time_bucket,
                 COUNT(*) AS orders, SUM(total) AS revenue
          FROM orders
          WHERE ${swWhere} AND status='done' AND COALESCE(settled_at, createdAt) >= ? AND COALESCE(settled_at, createdAt) < ?
          GROUP BY time_bucket
          ORDER BY time_bucket
        `, [...swParams, startOfDay.toISOString(), endOfDay.toISOString()]);
      } else if (granularity === 'month') {
        // 按月：每天聚合
        hourlyStats = await allAsync(`
          SELECT DATE(COALESCE(settled_at, createdAt)) AS time_bucket,
                 COUNT(*) AS orders, SUM(total) AS revenue
          FROM orders
          WHERE ${swWhere} AND status='done' AND COALESCE(settled_at, createdAt) >= ? AND COALESCE(settled_at, createdAt) < ?
          GROUP BY time_bucket
          ORDER BY time_bucket
        `, [...swParams, startOfDay.toISOString(), endOfDay.toISOString()]);
      } else {
        // 按年：每月聚合
        hourlyStats = await allAsync(`
          SELECT DATE_FORMAT(COALESCE(settled_at, createdAt), '%Y-%m') AS time_bucket,
                 COUNT(*) AS orders, SUM(total) AS revenue
          FROM orders
          WHERE store_id=? AND status='done' AND COALESCE(settled_at, createdAt) >= ? AND COALESCE(settled_at, createdAt) < ?
          GROUP BY time_bucket
          ORDER BY time_bucket
        `, [...swParams, startOfDay.toISOString(), endOfDay.toISOString()]);
      }
      // scope=all 时额外返回分店对比
      let storeBreakdown = null;
      if (isAll) {
        storeBreakdown = await allAsync(`
          SELECT s.id AS store_id, s.name AS store_name,
                 SUM(CASE WHEN o.id IS NOT NULL AND o.createdAt >= ? AND o.createdAt <= ? THEN 1 ELSE 0 END) AS orders,
                 SUM(CASE WHEN o.status='done' AND COALESCE(o.settled_at, o.createdAt) >= ? AND COALESCE(o.settled_at, o.createdAt) <= ? THEN 1 ELSE 0 END) AS completed_orders,
                 SUM(CASE WHEN o.status='canceled' AND o.createdAt >= ? AND o.createdAt <= ? THEN 1 ELSE 0 END) AS canceled_orders,
                 SUM(CASE WHEN o.status='done' AND COALESCE(o.settled_at, o.createdAt) >= ? AND COALESCE(o.settled_at, o.createdAt) <= ? THEN o.total ELSE 0 END) AS revenue
          FROM stores s
          LEFT JOIN orders o ON o.store_id = s.id
              AND ((o.createdAt >= ? AND o.createdAt <= ?) OR (o.status='done' AND COALESCE(o.settled_at, o.createdAt) >= ? AND COALESCE(o.settled_at, o.createdAt) <= ?))
          WHERE s.merchant_id = ?
          GROUP BY s.id, s.name
          ORDER BY revenue DESC, s.id
        `, [
          rangeStart, rangeEnd, rangeStart, rangeEnd, rangeStart, rangeEnd,
          rangeStart, rangeEnd, rangeStart, rangeEnd, rangeStart, rangeEnd, req.merchantId
        ]);
      }

      res.json({
        date,
        startDate,
        endDate,
        granularity,
        scope,
        storeBreakdown,
        summary: {
          totalOrders: orderStats?.total_orders || 0,
          completedOrders: orderStats?.completed_orders || 0,
          canceledOrders: orderStats?.canceled_orders || 0,
          totalRevenue: Number(orderStats?.total_revenue || 0),
          avgOrderValue: Number(orderStats?.avg_order_value || 0),
        },
        tableRevenue,
        dishRanking,
        hourlyStats,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/reports/summary', requireAdminKey, async (req, res) => {
    try {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      const todayStats = await getAsync(`
        SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
        FROM orders WHERE store_id=? AND status='done' AND COALESCE(settled_at, createdAt) >= ? AND COALESCE(settled_at, createdAt) <= ?
      `, [req.storeId, todayStart.toISOString(), todayEnd.toISOString()]);
      const monthStats = await getAsync(`
        SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
        FROM orders WHERE store_id=? AND status='done' AND COALESCE(settled_at, createdAt) >= ? AND COALESCE(settled_at, createdAt) <= ?
      `, [req.storeId, monthStart.toISOString(), monthEnd.toISOString()]);
      const topDishes = await allAsync(`
        SELECT m.id, m.name, m.emoji, m.price, m.category,
               SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS UNSIGNED)
                 - COALESCE(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].returnedQty')) AS UNSIGNED), 0)) AS sales_count
        FROM orders o
        JOIN (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) n
          ON JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) IS NOT NULL
        JOIN menus m ON m.id = CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) AS UNSIGNED)
        WHERE o.store_id=? AND o.status='done' AND COALESCE(o.settled_at, o.createdAt) >= ? AND COALESCE(o.settled_at, o.createdAt) <= ?
        GROUP BY m.id, m.name, m.emoji, m.price, m.category
        HAVING sales_count > 0
        ORDER BY sales_count DESC LIMIT 10
      `, [req.storeId, monthStart.toISOString(), monthEnd.toISOString()]);
      res.json({
        today: { revenue: Number(todayStats?.revenue || 0), orders: todayStats?.orders || 0 },
        month: { revenue: Number(monthStats?.revenue || 0), orders: monthStats?.orders || 0 },
        topDishes,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/info', requireAdminKey, async (req, res) => {
    try {
      const admin = await getAsync('SELECT id, username, display_name, merchant_id, created_at, last_login_at, active FROM merchant_admins WHERE id=?', [req.adminId]);
      const merchant = await getAsync('SELECT id, name, code, contact_name, contact_phone, max_stores, status, created_at FROM merchants WHERE id=?', [admin?.merchant_id]);
      const storeCount = await getAsync('SELECT COUNT(*) as count FROM stores WHERE merchant_id=?', [admin?.merchant_id]);
      res.json({ admin, merchant, storeCount: storeCount?.count || 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/admin/export/:type', requireAdminKey, async (req, res) => {
    try {
      const type = req.params.type;
      let rows = [], filename = '', headers = [];
      if (type === 'orders') {
        rows = await allAsync('SELECT * FROM orders WHERE store_id=? ORDER BY id DESC LIMIT 1000', [req.storeId]);
        filename = `orders_${new Date().toISOString().slice(0,10)}.csv`;
        headers = ['订单号','桌号','状态','金额','备注','下单时间'];
      } else if (type === 'menu') {
        rows = await allAsync('SELECT * FROM menus WHERE store_id=? ORDER BY id', [req.storeId]);
        filename = `menu_${new Date().toISOString().slice(0,10)}.csv`;
        headers = ['ID','名称','英文名','价格','货币','分类','单位','状态'];
      } else if (type === 'sales') {
        rows = await allAsync(`
          SELECT m.id, m.name, m.price, SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS UNSIGNED)) AS total_qty,
                 SUM((CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS DECIMAL(10,2)) - COALESCE(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].returnedQty')) AS DECIMAL(10,2)), 0)) * m.price) AS total_revenue
          FROM orders o
          JOIN (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) n
            ON JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) IS NOT NULL
          JOIN menus m ON m.id = CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) AS UNSIGNED)
          WHERE o.store_id=? AND o.status = 'done'
          GROUP BY m.id, m.name, m.price
          ORDER BY total_qty DESC
        `, [req.storeId]);
        filename = `sales_${new Date().toISOString().slice(0,10)}.csv`;
        headers = ['菜品ID','菜品名称','单价','销量','销售额'];
      } else {
        return res.status(400).json({ error: '不支持的导出类型' });
      }
      const csvRows = [headers.join(',')];
      for (const row of rows) {
        if (type === 'orders') {
          csvRows.push([row.id, row.table_name, row.status, row.total, `"${(row.note||'').replace(/"/g,'""')}"`, row.createdAt].join(','));
        } else if (type === 'menu') {
          csvRows.push([row.id, `"${row.name}"`, `"${row.name_en||''}"`, row.price, row.currency_code, `"${row.category||''}"`, row.unit, row.active].join(','));
        } else if (type === 'sales') {
          csvRows.push([row.id, `"${row.name}"`, row.price, row.total_qty || 0, row.total_revenue || 0].join(','));
        }
      }
      const csv = '\uFEFF' + csvRows.join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};

// ═══════════════════════════════════════════════════════════
// 高级导出：支持日期范围 + 状态 + 支付方式筛选
// ═══════════════════════════════════════════════════════════
module.exports.attachAdvancedExport = function(app, deps) {
  const { getAsync, allAsync, requireAdminKey } = deps;

  app.get('/api/admin/export-advanced', requireAdminKey, async (req, res) => {
    try {
      const storeId = req.storeId || 1;
      const startDate = req.query.startDate || '1970-01-01';
      const endDate = req.query.endDate || new Date().toISOString().slice(0, 10);
      const dimension = req.query.dimension || 'orders';     // orders | sales | tables
      const statuses = (req.query.statuses || 'done').split(',').filter(Boolean);
      const payMethods = (req.query.payMethods || '').split(',').filter(Boolean);

      const startIso = startDate + 'T00:00:00.000Z';
      const endIso = endDate + 'T23:59:59.999Z';

      let csv = '';
      let filename = '';

      if (dimension === 'orders') {
        // ===== 订单明细 =====
        const stPlaceholders = statuses.map(() => '?').join(',');
        const params = [storeId, startIso, endIso, ...statuses];
        let sql = `SELECT id, order_no, table_name, total, status, pay_method, note, createdAt FROM orders
                   WHERE store_id=? AND COALESCE(settled_at, createdAt) >= ? AND COALESCE(settled_at, createdAt) <= ? AND status IN (${stPlaceholders})`;
        if (payMethods.length) {
          sql += ` AND pay_method IN (${payMethods.map(() => '?').join(',')})`;
          params.push(...payMethods);
        }
        sql += ' ORDER BY createdAt DESC';
        const rows = await allAsync(sql, params);

        csv = '\uFEFF订单ID,订单号,桌号,金额,状态,支付方式,备注,下单时间\n';
        for (const r of rows) {
          csv += [
            r.id,
            r.order_no || '',
            `"${(r.table_name || '').replace(/"/g, '""')}"`,
            r.total,
            r.status,
            r.pay_method || '',
            `"${(r.note || '').replace(/"/g, '""')}"`,
            r.createdAt
          ].join(',') + '\n';
        }
        filename = `orders_${startDate}_${endDate}.csv`;

      } else if (dimension === 'sales') {
        // ===== 菜品销量 =====
        const stPlaceholders = statuses.map(() => '?').join(',');
        const rows = await allAsync(`
          SELECT m.id, m.name, m.category, m.price,
                 SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS UNSIGNED)
                   - COALESCE(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].returnedQty')) AS UNSIGNED), 0)) AS total_qty,
                 SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS DECIMAL(10,2)) * m.price) AS total_revenue
          FROM orders o
          JOIN (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
                UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) n
            ON JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) IS NOT NULL
          JOIN menus m ON m.id = CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) AS UNSIGNED)
          WHERE o.store_id=? AND COALESCE(o.settled_at, o.createdAt) >= ? AND COALESCE(o.settled_at, o.createdAt) <= ? AND o.status IN (${stPlaceholders})
          GROUP BY m.id, m.name, m.category, m.price
          HAVING total_qty > 0
          ORDER BY total_qty DESC
        `, [storeId, startIso, endIso, ...statuses]);

        csv = '\uFEFF菜品ID,菜品名称,分类,单价,销量,销售额\n';
        for (const r of rows) {
          csv += [r.id, `"${(r.name || '').replace(/"/g, '""')}"`,
                  `"${(r.category || '').replace(/"/g, '""')}"`,
                  r.price, r.total_qty || 0, r.total_revenue || 0].join(',') + '\n';
        }
        filename = `sales_${startDate}_${endDate}.csv`;

      } else if (dimension === 'tables') {
        // ===== 按桌汇总 =====
        const stPlaceholders = statuses.map(() => '?').join(',');
        const rows = await allAsync(`
          SELECT table_name, COUNT(*) AS order_count, SUM(total) AS revenue, AVG(total) AS avg_order
          FROM orders
          WHERE store_id=? AND createdAt >= ? AND createdAt <= ? AND status IN (${stPlaceholders})
          GROUP BY table_name
          ORDER BY revenue DESC
        `, [storeId, startIso, endIso, ...statuses]);

        csv = '\uFEFF桌号,订单数,总营收,客单价\n';
        for (const r of rows) {
          csv += [r.table_name, r.order_count, r.revenue, Number(r.avg_order || 0).toFixed(2)].join(',') + '\n';
        }
        filename = `tables_${startDate}_${endDate}.csv`;
      } else {
        return res.status(400).json({ error: '不支持的维度' });
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
