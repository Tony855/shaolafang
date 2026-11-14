'use strict';

module.exports = function registerHealthRoute(app, { getPool }) {
  const readinessHandler = async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const pool = getPool();
      await pool.query('SELECT 1');
      return res.status(200).json({ ok: true, status: 'ok', database: 'ok' });
    } catch (_) {
      return res.status(503).json({ ok: false, status: 'degraded', database: 'unavailable' });
    }
  };

  // Keep the canonical short path and backward-compatible aliases used by
  // existing load balancers and operator health-check scripts.
  app.get(['/health', '/api/health/ready', '/api/health'], readinessHandler);
};
