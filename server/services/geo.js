/* ============================================================
   server/services/geo.js — IP 地理位置查询
   ============================================================ */
const ipLocationCache = new Map();

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const ips = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (ips.length > 0) return ips[0];
  }
  const xri = req.headers['x-real-ip'];
  if (xri) return xri.trim();
  return req.ip || req.connection.remoteAddress || 'unknown';
}

async function getLocationByIp(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'unknown') return '本地/内网';
  if (ipLocationCache.has(ip)) return ipLocationCache.get(ip);
  try {
    const http = require('http');
    const url = 'http://ip-api.com/json/' + ip + '?lang=zh-CN&fields=status,country,regionName,city';
    const result = await new Promise((resolve, reject) => {
      http.get(url, { timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
    });
    if (result.status === 'success') {
      const location = (result.country || '') + ' ' + (result.regionName || '') + ' ' + (result.city || '');
      const trimmed = location.trim() || '未知';
      ipLocationCache.set(ip, trimmed);
      return trimmed;
    }
    return '未知';
  } catch (e) { return '未知'; }
}

module.exports = { getClientIp, getLocationByIp };
