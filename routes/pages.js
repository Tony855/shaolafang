/* ============================================================
   FoodFlow - 页面路由（HTML 页面 + 二维码打印）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

module.exports = function registerPageRoutes(app, ctx) {
  const { getAsync, requireAdminKey, requirePermission } = ctx;
  const ROOT = path.join(__dirname, '..');
  
  // 每次请求都读磁盘，不做版本号替换，让 HTML 里写死的 ?v=xxx 直接生效
  function sendHtml(res, file) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // 协商缓存：每次带 If-None-Match 问服务器，未改 304，改了 200
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.send(html);
  }

  // 静态语言包
  app.get('/languages.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(ROOT, 'languages.js'));
  });
  app.get('/languages.min.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(ROOT, 'languages.min.js'));
  });

  // i18n 按需加载（从 locales/*.json）
  const i18nCache = {};
  app.get('/api/i18n/:lang', (req, res) => {
    const lang = req.params.lang;
    if (!['zh','en','vi','th','km'].includes(lang)) return res.status(400).json({ error: 'Unsupported language' });
    if (i18nCache[lang]) return res.json(i18nCache[lang]);
    try {
      i18nCache[lang] = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', lang + '.json'), 'utf-8'));
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.json(i18nCache[lang]);
    } catch (e) {
      res.status(500).json({ error: 'Failed to load language' });
    }
  });

  // 页面路由
  app.get('/', (req, res) => sendHtml(res, 'index.html'));
  app.get(['/login', '/manage'], (req, res) => sendHtml(res, 'login.html'));
  app.get(['/index', '/home', '/order'], (req, res) => sendHtml(res, 'index.html'));
  app.get('/waiter', (req, res) => sendHtml(res, 'waiter.html'));
  app.get('/kitchen', (req, res) => sendHtml(res, 'kitchen.html'));
  app.get('/admin', (req, res) => sendHtml(res, 'admin.html'));
  app.get('/super', (req, res) => sendHtml(res, 'super.html'));
  app.get('/cashier', (req, res) => sendHtml(res, 'cashier.html'));
  app.get('/display', (req, res) => sendHtml(res, 'menu-display.html'));

  app.get('/login.html', (req, res) => res.redirect('/login'));
  app.get('/admin.html', (req, res) => res.redirect('/admin'));
  app.get('/kitchen.html', (req, res) => res.redirect('/kitchen'));
  app.get('/super.html', (req, res) => res.redirect('/super'));
  app.get('/waiter.html', (req, res) => res.redirect('/waiter'));
  app.get('/index.html', (req, res) => res.redirect('/'));

  // 二维码打印
  app.get('/qr-print', requireAdminKey, requirePermission('can_manage_table'), async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store, private');
      const tableId = parseInt(req.query.tableId || '0', 10);
      const lang = ['zh','en','vi','th','km'].includes(req.query.lang) ? req.query.lang : 'zh';
      if (!tableId) return res.status(400).send('Invalid tableId');
      const table = await getAsync('SELECT name, qr_token, store_id FROM tables WHERE id = ? AND store_id = ?', [tableId, req.storeId]);
      if (!table) return res.status(404).send('Table not found');
      const store = await getAsync('SELECT name, qr_languages FROM stores WHERE id = ? AND merchant_id = ?', [table.store_id || 1, req.merchantId]);
      const storeName = store?.name || 'FoodFlow';
      let displayLangs = ['zh'];
      if (store?.qr_languages) {
        const configured = store.qr_languages.split(',').map(s => s.trim()).filter(s => ['zh','en','vi','th','km'].includes(s));
        if (configured.length > 0) displayLangs = configured;
      }
      const url = `${req.protocol}://${req.get('host')}/?token=${encodeURIComponent(table.qr_token)}`;
      const qrDataUrl = await QRCode.toDataURL(url);
      const i18nMap = {
        zh: { table: '桌号', qrCode: '二维码', scanToOrder: '扫码点餐', download: '下载', print: '打印', orderingQrCode: '点餐二维码', copy: '复制', copied: '已复制', copyLink: '复制链接', copyFailed: '复制失败，请手动复制' },
        en: { table: 'Table', qrCode: 'QR Code', scanToOrder: 'Scan to Order', download: 'Download', print: 'Print', orderingQrCode: 'Ordering QR Code', copy: 'Copy', copied: 'Copied', copyLink: 'Copy Link', copyFailed: 'Copy failed, please copy manually' },
        vi: { table: 'Bàn', qrCode: 'Mã QR', scanToOrder: 'Quét mã để đặt hàng', download: 'Tải xuống', print: 'In', orderingQrCode: 'Mã QR đặt hàng', copy: 'Sao chép', copied: 'Đã sao chép', copyLink: 'Sao chép liên kết', copyFailed: 'Sao chép thất bại' },
        th: { table: 'โต๊ะ', qrCode: 'คิวอาร์โค้ด', scanToOrder: 'สแกนเพื่อสั่งอาหาร', download: 'ดาวน์โหลด', print: 'พิมพ์', orderingQrCode: 'คิวอาร์โค้ดสั่งอาหาร', copy: 'คัดลอก', copied: 'คัดลอกแล้ว', copyLink: 'คัดลอกลิงก์', copyFailed: 'คัดลอกล้มเหลว' },
        km: { table: 'តុ', qrCode: 'QR Code', scanToOrder: 'ស្កេនដើម្បីបញ្ជាទិញ', download: 'ទាញយក', print: 'បោះពុម្ព', orderingQrCode: 'កូដ QR បញ្ជាទិញ', copy: 'ចម្លង', copied: 'បានចម្លង', copyLink: 'ចម្លងតំណ', copyFailed: 'ការចម្លងបរាជ័យ' }
      };
      const t = i18nMap[lang] || i18nMap.zh;
      const templatePath = path.join(ROOT, 'views', 'qr-print.html');
      if (!fs.existsSync(templatePath)) return res.status(500).send('QR template missing');
      const template = fs.readFileSync(templatePath, 'utf-8');
      const html = template
        .replace(/{{lang}}/g, lang)
        .replace(/{{table}}/g, table.name)
        .replace(/{{storeName}}/g, storeName)
        .replace(/{{qrCode}}/g, t.qrCode)
        .replace(/{{tableLabel}}/g, t.table)
        .replace(/{{orderingQrCode}}/g, t.orderingQrCode)
        .replace(/{{scanToOrder}}/g, displayLangs.map(l => (i18nMap[l] || i18nMap.zh).scanToOrder).join('\n'))
        .replace(/{{scanToOrderLines}}/g, displayLangs.map(l => '<div class="scan-line">' + (i18nMap[l] || i18nMap.zh).scanToOrder + '</div>').join(''))
        .replace(/{{download}}/g, t.download)
        .replace(/{{print}}/g, t.print)
        .replace(/{{copy}}/g, t.copy)
        .replace(/{{copied}}/g, t.copied)
        .replace(/{{copyLink}}/g, t.copyLink)
        .replace(/{{copyFailed}}/g, t.copyFailed)
        .replace(/{{url}}/g, url)
        .replace(/{{qrDataUrl}}/g, qrDataUrl)
        .replace(/{{storeNameJson}}/g, JSON.stringify(storeName))
        .replace(/{{tableJson}}/g, JSON.stringify(table.name))
        .replace(/{{tableLabelJson}}/g, JSON.stringify(t.table))
        .replace(/{{scanToOrderJson}}/g, JSON.stringify(displayLangs.map(l => (i18nMap[l] || i18nMap.zh).scanToOrder)))
        .replace(/{{qrCodeJson}}/g, JSON.stringify(t.qrCode))
        .replace(/{{qrDataUrlJson}}/g, JSON.stringify(qrDataUrl));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (e) {
      console.error('QR print error:', e);
      res.status(500).send('Failed to generate QR print page');
    }
  });
};
