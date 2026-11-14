'use strict';

module.exports = function registerHealthRoute(app, { getPool }) {
  const readinessHandler = async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const pool = getPool();
      await pool.query('SELECT 1');
      return res.status(200).json({ status: 'ok', database: 'ok' });
    } catch (_) {
      return res.status(503).json({ status: 'degraded', database: 'unavailable' });
    }
  };

  // Keep /health canonical and retain aliases for older monitors.
  app.get('/health', readinessHandler);
  app.get('/api/health/ready', readinessHandler);
  app.get('/api/health', readinessHandler);
};
