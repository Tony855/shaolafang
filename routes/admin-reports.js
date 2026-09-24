/* ============================================================
   routes/admin-reports.js — 报表 + 管理员信息
   ============================================================ */
module.exports = function(app, deps) {
  const { getAsync, allAsync, requireAdminKey } = deps;

  app.get('/api/admin/reports/daily', requireAdminKey, async (req, res) => {
    try {
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      const startOfDay = new Date(date + 'T00:00:00.000Z');
      const endOfDay = new Date(date + 'T23:59:59.999Z');
      const orderStats = await getAsync(`
        SELECT
          COUNT(*) AS total_orders,
          SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS completed_orders,
          SUM(CASE WHEN status='canceled' THEN 1 ELSE 0 END) AS canceled_orders,
          SUM(CASE WHEN status='done' THEN total ELSE 0 END) AS total_revenue,
          AVG(CASE WHEN status='done' THEN total END) AS avg_order_value
        FROM orders
        WHERE store_id=? AND createdAt >= ? AND createdAt <= ?
      `, [req.storeId, startOfDay.toISOString(), endOfDay.toISOString()]);
      const tableRevenue = await allAsync(`
        SELECT table_name, COUNT(*) AS orders, SUM(total) AS revenue
        FROM orders
        WHERE store_id=? AND status='done' AND createdAt >= ? AND createdAt <= ?
        GROUP BY table_name
        ORDER BY revenue DESC
      `, [req.storeId, startOfDay.toISOString(), endOfDay.toISOString()]);
      const dishRanking = await allAsync(`
        SELECT m.name, m.emoji,
               SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS UNSIGNED)
                 - COALESCE(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].returnedQty')) AS UNSIGNED), 0)) AS quantity
        FROM orders o
        JOIN (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) n
          ON JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) IS NOT NULL
        JOIN menus m ON m.id = CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) AS UNSIGNED)
        WHERE o.store_id=? AND o.status='done' AND o.createdAt >= ? AND o.createdAt <= ?
        GROUP BY m.id, m.name, m.emoji
        HAVING quantity > 0
        ORDER BY quantity DESC
        LIMIT 10
      `, [req.storeId, startOfDay.toISOString(), endOfDay.toISOString()]);
      const hourlyStats = await allAsync(`
        SELECT CONCAT(LPAD(HOUR(createdAt),2,'0'), ':', LPAD(FLOOR(MINUTE(createdAt)/10)*10, 2, '0')) AS time_bucket,
               COUNT(*) AS orders, SUM(total) AS revenue
        FROM orders
        WHERE store_id=? AND status='done' AND createdAt >= ? AND createdAt < ?
        GROUP BY time_bucket
        ORDER BY time_bucket
      `, [req.storeId, startOfDay.toISOString(), endOfDay.toISOString()]);
      res.json({
        date,
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
        FROM orders WHERE store_id=? AND status='done' AND createdAt >= ? AND createdAt <= ?
      `, [req.storeId, todayStart.toISOString(), todayEnd.toISOString()]);
      const monthStats = await getAsync(`
        SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS orders
        FROM orders WHERE store_id=? AND status='done' AND createdAt >= ? AND createdAt <= ?
      `, [req.storeId, monthStart.toISOString(), monthEnd.toISOString()]);
      const topDishes = await allAsync(`
        SELECT m.id, m.name, m.emoji, m.price, m.category,
               SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS UNSIGNED)
                 - COALESCE(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].returnedQty')) AS UNSIGNED), 0)) AS sales_count
        FROM orders o
        JOIN (SELECT 0 AS idx UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) n
          ON JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) IS NOT NULL
        JOIN menus m ON m.id = CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].id')) AS UNSIGNED)
        WHERE o.store_id=? AND o.status='done' AND o.createdAt >= ? AND o.createdAt <= ?
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
                 SUM(CAST(JSON_EXTRACT(o.items, CONCAT('$[', n.idx, '].quantity')) AS DECIMAL(10,2)) * m.price) AS total_revenue
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
