/* ============================================================
   server/services/geo.js — IP 地理位置查询
   ============================================================ */
const ipLocationCache = new Map();

function getClientIp(req) {
  // Express has already applied the configured trust-proxy policy to req.ip.
  // Never read forwarding headers directly: untrusted clients can spoof them.
  const clientIp = typeof req.ip === 'string' ? req.ip.trim() : '';
  if (clientIp) return clientIp;
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

async function getLocationByIp(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === 'unknown') return '本地/内网';
  if (ipLocationCache.has(ip)) return ipLocationCache.get(ip);
  try {
    const http = require('http');
    const url = 'http://ip-api.com/json/' + encodeURIComponent(ip) + '?lang=zh-CN&fields=status,country,regionName,city';
    const result = await new Promise((resolve, reject) => {
      const request = http.get(url, { timeout: 3000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('timeout')));
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
