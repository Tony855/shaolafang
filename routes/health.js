'use strict';

module.exports = function registerHealthRoute(app, { getPool }) {
  app.get('/health', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const pool = getPool();
      await pool.query('SELECT 1');
      return res.status(200).json({ status: 'ok', database: 'ok' });
    } catch (_) {
      return res.status(503).json({ status: 'degraded', database: 'unavailable' });
    }
  });
};
