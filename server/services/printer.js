/* ============================================================
   server/services/printer.js — ESC/POS 打印 + 小票构建
   ============================================================ */
const net = require('net');
const { formatGlobalDateTime, formatGlobalTime } = require('../config/constants');

class EscPosBuilder {
  constructor(paperWidth) {
    this.width = paperWidth || 58;
    this.charsPerLine = this.width === 80 ? 48 : 32;
    this.buffer = Buffer.alloc(0);
  }
  _append(bytes) { this.buffer = Buffer.concat([this.buffer, Buffer.from(bytes)]); return this; }
  init() { return this._append([0x1b, 0x40]); }
  align(n) { return this._append([0x1b, 0x61, n]); }
  font(n) { return this._append([0x1b, 0x4d, n]); }
  bold(on) { return this._append([0x1b, 0x45, on ? 1 : 0]); }
  doubleHeight(on) { return this._append([0x1b, 0x21, on ? 0x10 : 0x00]); }
  doubleWidth(on) { return this._append([0x1b, 0x21, on ? 0x20 : 0x00]); }
  big(on) { return this._append([0x1b, 0x21, on ? 0x30 : 0x00]); }
  underline(on) { return this._append([0x1b, 0x2d, on ? 1 : 0]); }
  text(str) { return this._append(Buffer.from(str, 'utf8')); }
  line(str) { return this.text(str || '').newline(); }
  newline(n = 1) { for (let i = 0; i < n; i++) this._append([0x0a]); return this; }
  feed(n = 3) { return this._append([0x1b, 0x4a, n]); }
  cut(mode = 1) { this.feed(3); return this._append([0x1d, 0x56, mode ? 1 : 0]); }
  separator(char = '-') { return this.line(char.repeat(this.charsPerLine)); }
  twoColumn(left, right) {
    const leftStr = String(left || '');
    const rightStr = String(right || '');
    const leftWidth = [...leftStr].reduce((sum, c) => sum + (/[\u4e00-\u9fa5]/.test(c) ? 2 : 1), 0);
    const rightWidth = [...rightStr].reduce((sum, c) => sum + (/[\u4e00-\u9fa5]/.test(c) ? 2 : 1), 0);
    const spaces = Math.max(1, this.charsPerLine - leftWidth - rightWidth);
    return this.line(leftStr + ' '.repeat(spaces) + rightStr);
  }
  barcode(code, type = 2) {
    this._append([0x1d, 0x6b, type]);
    this._append(Buffer.from(code, 'ascii'));
    this._append([0x00]);
    return this;
  }
  qrCode(text) {
    const data = Buffer.from(text, 'utf8');
    const len = data.length + 3;
    const pL = len & 0xff;
    const pH = (len >> 8) & 0xff;
    this._append([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x08]);
    this._append([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x41, 0x32, 0x00]);
    this._append([0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]);
    this._append(data);
    this._append([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]);
    return this;
  }
  cashDrawer() { return this._append([0x1b, 0x70, 0x00, 0x40, 0xff]); }
  build() { return this.buffer; }
}

function buildReceipt(order, store, printer) {
  const width = printer?.paper_width || 58;
  const pos = new EscPosBuilder(width);

  const payLabel = {
    cash: '现金', wechat: '微信', alipay: '支付宝',
    card: '刷卡', aba: 'ABA',
  }[order.pay_method] || '';

  pos.init();

  // ===== 顶部：店名大号居中 =====
  pos.align(1);
  pos.big(true);
  pos.line(store?.name || 'FoodFlow');
  pos.big(false);
  pos.separator('=');

  // ===== 订单信息（两端对齐）=====
  pos.align(0);
  pos.twoColumn(order.table || '-', `#${order.order_no || order.id}`);
  pos.twoColumn(formatGlobalDateTime(order.createdAt), payLabel || '未支付');
  pos.separator('-');

  // ===== 菜品明细（一行一道）=====
  (order.items || []).forEach(item => {
    const qty = (Number(item.quantity) || 0) - (Number(item.returnedQty) || 0);
    const unitPrice = Number(item.base_price) || Number(item.price) || 0;
    let name = item.name || '';
    if (name.length > 14) name = name.slice(0, 13) + '..';
    pos.twoColumn(`${name} x${qty}`, `$${(unitPrice * qty).toFixed(2)}`);
  });

  pos.separator('=');

  // ===== 商品数 + 合计 =====
  const totalItems = (order.items || []).reduce(
    (s, i) => s + (Number(i.quantity) || 0) - (Number(i.returnedQty) || 0), 0
  );
  pos.align(0);
  pos.twoColumn('商品数', `${totalItems}件`);
  pos.bold(true);
  pos.twoColumn('合计', `$${Number(order.total).toFixed(2)}`);
  pos.bold(false);
  pos.separator('=');

  // ===== 底部问候 =====
  pos.align(1);
  pos.line('谢谢惠顾');
  pos.newline(2);
  pos.cut(1);
  return pos.build();
}

function buildBatchReceipt(orders, store, printer) {
  const width = printer?.paper_width || 58;
  const pos = new EscPosBuilder(width);
  const tableName = orders[0]?.table_name || '';
  const total = orders.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
  pos.init();
  pos.align(1); pos.big(true);
  pos.line(store?.name || 'FoodFlow');
  pos.big(false); pos.newline();
  if (store?.address) { pos.font(1); pos.line(store.address); pos.font(0); }
  pos.separator('='); pos.newline();
  pos.align(0);
  pos.twoColumn('桌号:', tableName);
  pos.twoColumn('订单数:', String(orders.length));
  pos.twoColumn('时间:', formatGlobalDateTime(new Date().toISOString()));
  pos.separator();
  const mergedItems = {};
  for (const o of orders) {
    const items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items;
    for (const item of items) {
      const key = item.name;
      if (!mergedItems[key]) mergedItems[key] = { ...item };
      else mergedItems[key].quantity += item.quantity;
    }
  }
  pos.line('菜品清单');
  pos.separator('-');
  for (const item of Object.values(mergedItems)) {
    const name = item.name.length > 16 ? item.name.slice(0, 15) + '..' : item.name;
    pos.twoColumn((item.emoji || '') + name + ' x' + item.quantity, '$' + ((Number(item.base_price) || Number(item.price) || 0) * item.quantity).toFixed(2));
  }
  pos.separator();
  pos.align(2); pos.bold(true);
  pos.line('合计: $' + total.toFixed(2));
  pos.bold(false); pos.newline();
  pos.align(1);
  pos.line('谢谢惠顾，欢迎再次光临！');
  pos.newline(2); pos.cut(1);
  return pos.build();
}

function buildKitchenTicket(order, store, printer) {
  const width = printer?.paper_width || 58;
  const pos = new EscPosBuilder(width);
  const pendingItems = (order.items || []).filter(i => i.itemStatus !== 'done');

  pos.init();

  // ===== 顶部：桌号 + 订单号同行居中加粗 =====
  pos.align(1);
  pos.bold(true);
  pos.line(`${order.table || '-'}   #${order.order_no || order.id}`);
  pos.bold(false);
  pos.separator('=');

  // ===== 菜品明细 =====
  pos.align(0);
  pendingItems.forEach((item, idx) => {
    const name = item.name || '';
    const qty = `x${item.quantity}`;
    const maxNameLen = 20;
    const displayName = name.length > maxNameLen ? name.slice(0, maxNameLen - 2) + '..' : name;
    pos.twoColumn(`${idx + 1}. ${displayName}`, qty);
    if (item.note) {
      pos.line(`   * ${item.note}`);
    }
  });

  // ===== 订单备注 =====
  if (order.note) {
    pos.separator('-');
    pos.line(`备注: ${order.note}`);
  }

  // ===== 时间 =====
  pos.separator('-');
  pos.align(1);
  pos.line(formatGlobalTime(order.createdAt));
  pos.newline(2);
  pos.cut(1);
  return pos.build();
}

function sanitizePrinterError() {
  return '打印机连接失败，请检查设备连接和网络设置';
}

async function printToNetworkPrinter(data, ip, port) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timeout = 10000;
    socket.setTimeout(timeout);
    socket.on('timeout', () => { socket.destroy(); reject(new Error('打印机连接超时')); });
    socket.on('error', (err) => { reject(new Error(`打印机连接失败: ${err.message}`)); });
    socket.connect(port || 9100, ip, () => {
      socket.write(data, () => {
        setTimeout(() => { socket.destroy(); resolve(true); }, 500);
      });
    });
  });
}

// ============================================================
//  统一打印入口（所有打印场景都调这个）
// ============================================================
/**
 * dispatchPrint — 打印统一入口
 * @param {Object} opts
 *   - order     订单对象（已 formatOrder 或原始 row）
 *   - orders    批量订单数组（type='batch' 时用）
 *   - type      'receipt' | 'kitchen' | 'batch'
 *   - store     店铺信息 { name, address, phone }
 *   - printer   打印机对象（可选；不传则用默认打印机）
 *   - getAsync  DB 查询函数（用于查默认打印机）
 * @returns {Object} { success, printed, printer, error, printData }
 */
async function dispatchPrint(opts) {
  const { order, orders, type, store, printer, getAsync } = opts;
  let targetPrinter = printer;
  const storeInfo = store ? { name: store.name || '', address: store.address || '', phone: store.phone || '' } : null;

  // 未传打印机 → 查默认打印机（优先按 role 匹配）
  if (!targetPrinter && getAsync) {
    const storeId = (order && order.store_id) || (orders && orders[0] && orders[0].store_id) || 1;
    const wantRole = type === 'kitchen' ? 'kitchen' : 'front';
    // 优先匹配 role，其次 is_default
    targetPrinter = await getAsync(
      "SELECT * FROM printers WHERE store_id=? AND active=1 AND role IN (?, 'both') ORDER BY is_default DESC, id LIMIT 1",
      [storeId, wantRole]
    ).catch(() => null);
    if (!targetPrinter) {
      // 兼容旧表（没有 role 字段时）
      targetPrinter = await getAsync(
        'SELECT * FROM printers WHERE store_id=? AND is_default=1 AND active=1',
        [storeId]
      ).catch(() => null);
    }
  }

  // 无打印机 → 返回未打印（让前端调浏览器打印兜底）
  if (!targetPrinter) {
    let printData = null;
    try {
      if (type === 'kitchen') printData = buildKitchenTicket(order, store, null);
      else if (type === 'batch') printData = buildBatchReceipt(orders, store, null);
      else printData = buildReceipt(order, store, null);
    } catch (e) {
      return { success: false, printed: false, error: '打印任务生成失败，请检查订单数据' };
    }
    return {
      success: true,
      printed: false,
      printer: null,
      printData: printData.toString('base64'),
      message: '无可用打印机，请使用前端打印',
      store: storeInfo
    };
  }

  // 构建打印内容
  let printData;
  try {
    if (type === 'kitchen') printData = buildKitchenTicket(order, store, targetPrinter);
    else if (type === 'batch') printData = buildBatchReceipt(orders, store, targetPrinter);
    else printData = buildReceipt(order, store, targetPrinter);
  } catch (e) {
    return { success: false, printed: false, error: '打印任务生成失败，请检查订单数据' };
  }

  // 网络打印机 → 直接打
  if (targetPrinter.type === 'network' && targetPrinter.ip_address) {
    try {
      await printToNetworkPrinter(printData, targetPrinter.ip_address, targetPrinter.port);
      return { success: true, printed: true, printer: targetPrinter.name, store: storeInfo };
    } catch (e) {
      return {
        success: false,
        printed: false,
        error: sanitizePrinterError(),
        printer: targetPrinter.name,
        printData: printData.toString('base64'),
        store: storeInfo
      };
    }
  }

  // 其他类型打印机（USB/蓝牙）→ 返回数据让前端处理
  return {
    success: true,
    printed: false,
    printer: targetPrinter.name,
    printData: printData.toString('base64'),
    message: '请使用前端打印',
    store: storeInfo
  };
}

module.exports = {
  EscPosBuilder,
  buildReceipt,
  buildBatchReceipt,
  buildKitchenTicket,
  printToNetworkPrinter,
  dispatchPrint,
  sanitizePrinterError,
};
