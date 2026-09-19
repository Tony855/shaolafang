const fs = require('fs');
const p = 'C:/Users/DONGFeng/Downloads/shaolafang/cashier.html';
let lines = fs.readFileSync(p, 'utf8').split('\n');

// 1. 在 orderList 前加搜索框和批量操作栏
let orderListIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('<div id="orderList"></div>')) { orderListIdx = i; break; }
}
console.log('orderList at', orderListIdx + 1);

const searchHtml = [
  '      <div class="search-bar">',
  '        <input type="text" id="tableSearch" placeholder="🔍 ' + '{{searchPlaceholder}}' + '" oninput="filterByTable()" style="flex:1;padding:10px 14px;border:1px solid var(--gray-2);border-radius:10px;font-size:14px;outline:none;">',
  '        <button class="btn" onclick="clearSearch()" style="margin-left:8px;">✕</button>',
  '      </div>',
  '      <div id="batchBar" style="display:none;position:sticky;bottom:0;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:12px 16px;border-radius:12px 12px 0 0;box-shadow:0 -2px 12px rgba(0,0,0,0.15);z-index:100;display:none;align-items:center;justify-content:space-between;">',
  '        <div><span id="batchCount">0</span> ' + '{{itemsSelected}} + ' + '<b id="batchTotal">$0.00</b></div>',
  '        <div style="display:flex;gap:8px;">',
  '          <button class="btn" onclick="batchPrint()" style="background:rgba(255,255,255,0.2);color:#fff;border:none;">🖨 ' + '{{printBtn}}' + '</button>',
  '          <button class="btn btn-primary" onclick="batchSettle()" style="background:#fff;color:#667eea;border:none;font-weight:700;">' + '{{settleBtn}}' + '</button>',
  '        </div>',
  '      </div>'
];

lines.splice(orderListIdx, 0, ...searchHtml);
fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('search bar added');
