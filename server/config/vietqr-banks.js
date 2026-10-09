/* ============================================================
   server/config/vietqr-banks.js — VietQR 越南银行 BIN 映射

   ★ 加新越南银行 → 只改这个文件
   ★ BIN 码由 NAPAS 分配，官方 API: https://api.vietqr.io/v2/banks
   ★ 图标文件放 assets/vendor/payment-icons/
   ============================================================ */

/** BIN → 银行信息 */
const VIETQR_BANKS = {
  '970436': { name: 'Vietcombank', icon: 'vietcombank.png' },
  '970415': { name: 'VietinBank',  icon: 'vietinbank.png' },
  '970418': { name: 'BIDV',        icon: 'bidv.png' },
  '970405': { name: 'Agribank',    icon: 'agribank.png' },
  '970407': { name: 'Techcombank', icon: 'techcombank.png' },
  '970422': { name: 'MBBank',      icon: 'mbbank.png' },
  '970416': { name: 'ACB',         icon: 'acb.png' },
  '970432': { name: 'VPBank',      icon: 'vpbank.png' },
  '970437': { name: 'HDBank',      icon: 'hdbank.png' },
  '970443': { name: 'SHB',         icon: 'shb.png' },
  '970403': { name: 'Sacombank',   icon: 'sacombank.png' },
  '970423': { name: 'TPBank',      icon: 'tpbank.png' },
  '970441': { name: 'VIB',         icon: 'vib.png' },
  '970426': { name: 'MSB',         icon: 'msb.png' },
  '970448': { name: 'OCB',         icon: 'ocb.png' },
  '970440': { name: 'SeABank',     icon: 'seabank.png' },
  '970431': { name: 'Eximbank',    icon: 'eximbank.png' },
  '970449': { name: 'LPBank',      icon: 'lpbank.png' },
  '970429': { name: 'SCB',         icon: 'scb.png' },
  '970452': { name: 'KienLongBank', icon: 'kienlongbank.png' },
};

const DEFAULT_BANK = { name: 'VietQR', icon: 'vietqr.png' };

/** 从 BIN 识别银行 */
function identifyVietBank(bin) {
  const b = String(bin || '').trim();
  if (!b) return { ...DEFAULT_BANK };
  return VIETQR_BANKS[b] || { ...DEFAULT_BANK };
}

/** BIN → 银行名 映射（给前端用） */
function getVietBankNameMap() {
  const map = {};
  for (const [bin, info] of Object.entries(VIETQR_BANKS)) {
    map[bin] = info.name;
  }
  return map;
}

module.exports = {
  VIETQR_BANKS,
  DEFAULT_BANK,
  identifyVietBank,
  getVietBankNameMap,
};
