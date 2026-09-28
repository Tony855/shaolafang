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
  pos.init();
  pos.align(1);
  pos.big(true);
  pos.line(store?.name || 'FoodFlow');
  pos.big(false);
  pos.newline();
  if (store?.address) { pos.font(1); pos.line(store.address); pos.font(0); }
  pos.separator('=');
  pos.newline();
  pos.align(0);
  pos.twoColumn('订单号:', `#${order.id}`);
  pos.twoColumn('桌号:', order.table);
  pos.twoColumn('时间:', formatGlobalDateTime(order.createdAt));
  if (order.note) pos.line(`备注: ${order.note}`);
  pos.separator();
  pos.line('菜品');
  pos.separator('-');
  for (const item of order.items) {
    const name = item.name.length > 16 ? item.name.slice(0, 15) + '..' : item.name;
    pos.twoColumn(`${item.emoji || ''}${name} x${item.quantity}`, `$${((Number(item.base_price) || Number(item.price) || 0) * item.quantity).toFixed(2)}`);
  }
  pos.separator();
  pos.align(2);
  pos.bold(true);
  pos.line(`合计: $${Number(order.total).toFixed(2)}`);
  pos.bold(false);
  pos.newline();
  pos.align(1);
  pos.line('谢谢惠顾，欢迎再次光临！');
  pos.newline(2);
  try { pos.qrCode(`order:${order.id}`); pos.newline(); } catch (e) {}
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
  pos.init();
  pos.align(1);
  pos.big(true);
  pos.line('后厨订单');
  pos.big(false);
  pos.newline();
  pos.separator('=');
  pos.align(0);
  pos.twoColumn('桌号:', order.table);
  pos.twoColumn('订单号:', `#${order.id}`);
  pos.twoColumn('时间:', formatGlobalTime(order.createdAt));
  if (order.note) pos.line(`备注: ${order.note}`);
  pos.separator();
  const pendingItems = order.items.filter(i => i.itemStatus !== 'done');
  for (const item of pendingItems) {
    pos.bold(true);
    pos.line(`${item.emoji || ''} ${item.name} x${item.quantity}`);
    pos.bold(false);
  }
  pos.newline(3);
  pos.cut(1);
  return pos.build();
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

module.exports = { EscPosBuilder, buildReceipt, buildBatchReceipt, buildKitchenTicket, printToNetworkPrinter };
