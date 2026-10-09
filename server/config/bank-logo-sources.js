/* ============================================================
   server/config/bank-logo-sources.js — 三国银行 Logo 数据源

   ★ 加新银行 → 在此文件加一条 { name, icon, domain }
   ★ 然后跑 node scripts/fetch-bank-logos.js
   ============================================================ */
'use strict';

// ============ 柬埔寨 KHQR（Bakong 体系）============
const KHQR_BANKS = [
  { name: 'ABA',          icon: 'aba.png',         domain: 'ababank.com' },
  { name: 'ACLEDA',       icon: 'acleda.png',      domain: 'acleda.com.kh' },
  { name: 'Wing',         icon: 'Wing.png',        domain: 'wingbank.com.kh' },
  { name: 'Bakong',       icon: 'KHQR.png',        domain: 'bakong.nbc.gov.kh' },
  { name: 'Chip Mong',    icon: 'chipmong.png',    domain: 'chipmongbank.com.kh' },
  { name: 'Canadia',      icon: 'canadia.png',     domain: 'canadiabank.com.kh' },
  { name: 'Vattanac',     icon: 'vattanac.png',    domain: 'vattanacbank.com' },
  { name: 'Maybank',      icon: 'maybank.png',     domain: 'maybank.com.kh' },
  { name: 'J Trust Royal',icon: 'jtrust.png',      domain: 'jtrustroyal.com' },
  { name: 'Sathapana',    icon: 'sathapana.png',   domain: 'sathapana.com.kh' },
  { name: 'Hattha',       icon: 'hattha.png',      domain: 'hatthabank.com' },
  { name: 'CPBank',       icon: 'cpbank.png',      domain: 'cpbank.com.kh' },
  { name: 'Phillip Bank', icon: 'phillip.png',     domain: 'phillipbank.com.kh' },
  { name: 'KB Prasac',    icon: 'kbprasac.png',    domain: 'kbprasacbank.com.kh' },
  { name: 'PPCBank',      icon: 'ppcbank.png',     domain: 'ppcbank.com.kh' },
  { name: 'Prince Bank',  icon: 'prince.png',      domain: 'princebank.com.kh' },
  { name: 'FTB',          icon: 'ftb.png',         domain: 'ftbbank.com' },
  { name: 'Shinhan KH',   icon: 'shinhan.png',     domain: 'shinhan.com.kh' },
  { name: 'Woori KH',     icon: 'woori.png',       domain: 'wooribank.com.kh' },
  { name: 'First Comm.',  icon: 'firstcom.png',    domain: 'fcbcambodia.com' },
  { name: 'Amret',        icon: 'amret.png',       domain: 'amret.com.kh' },
  { name: 'LOLC',         icon: 'lolc.png',        domain: 'lolc.com.kh' },
  { name: 'Moha',         icon: 'moha.png',        domain: 'moha.com.kh' },
];

// ============ 泰国 PromptPay ============
const PROMPTPAY_BANKS = [
  { name: 'KBank',        icon: 'kbank.png',       domain: 'kasikornbank.com' },
  { name: 'SCB',          icon: 'scb-th.png',      domain: 'scb.co.th' },
  { name: 'Bangkok Bank', icon: 'bbl.png',         domain: 'bangkokbank.com' },
  { name: 'Krungthai',    icon: 'ktb.png',         domain: 'krungthai.com' },
  { name: 'TTB',          icon: 'ttb.png',         domain: 'ttbbank.com' },
  { name: 'Krungsri',     icon: 'krungsri.png',    domain: 'krungsri.com' },
  { name: 'CIMB Thai',    icon: 'cimb-th.png',     domain: 'cimbthai.com' },
  { name: 'UOB Thai',     icon: 'uob-th.png',      domain: 'uob.co.th' },
  { name: 'KKP',          icon: 'kkp.png',         domain: 'kkpbank.com' },
  { name: 'TISCO',        icon: 'tisco.png',       domain: 'tisco.co.th' },
  { name: 'LH Bank',      icon: 'lhbank.png',      domain: 'lhbank.co.th' },
  { name: 'ICBC Thai',    icon: 'icbc-th.png',     domain: 'icbcthai.com' },
  { name: 'GSB',          icon: 'gsb.png',         domain: 'gsb.or.th' },
  { name: 'BAAC',         icon: 'baac.png',        domain: 'baac.or.th' },
  { name: 'GHB',          icon: 'ghb.png',         domain: 'ghbank.co.th' },
  { name: 'IBank',        icon: 'ibank.png',       domain: 'ibank.co.th' },
  { name: 'Standard Chartered TH', icon: 'sc-th.png', domain: 'sc.com' },
  { name: 'Bank of China TH', icon: 'boc-th.png',  domain: 'bankofchina.com' },
];

// ============ 越南 VietQR（从官方 API 动态拉）============
const VIETQR = {
  apiUrl: 'https://api.vietqr.io/v2/banks',
  // BIN → 目标文件名（下载时匹配）
  // 未列出的 BIN 会被跳过
  binMap: {
    '970436': 'vietcombank.png',
    '970415': 'vietinbank.png',
    '970418': 'bidv.png',
    '970405': 'agribank.png',
    '970407': 'techcombank.png',
    '970422': 'mbbank.png',
    '970416': 'acb.png',
    '970432': 'vpbank.png',
    '970437': 'hdbank.png',
    '970443': 'shb.png',
    '970403': 'sacombank.png',
    '970423': 'tpbank.png',
    '970441': 'vib.png',
    '970426': 'msb.png',
    '970448': 'ocb.png',
    '970440': 'seabank.png',
    '970431': 'eximbank.png',
    '970449': 'lpbank.png',
    '970429': 'scb.png',
    '970452': 'kienlongbank.png',
    '970412': 'pvcombank.png',
    '970419': 'ncb.png',
    '970425': 'abbank.png',
    '970427': 'vietabank.png',
    '970428': 'namabank.png',
    '970433': 'vietbank.png',
    '970438': 'baovietbank.png',
    '970414': 'oceanbank.png',
    '970409': 'bacabank.png',
    '970400': 'saigonbank.png',
    '970452': 'kienlongbank.png',
  },
};

// ============ 通用的 Logo 源（自动生成）============
// 每家银行按顺序尝试这些 URL 模板
// {domain} 会被替换
const FALLBACK_URL_TEMPLATES = [
  'https://www.google.com/s2/favicons?domain={domain}&sz=128',
  'https://logo.clearbit.com/{domain}',
  'https://{domain}/apple-touch-icon.png',
  'https://{domain}/favicon.ico',
];

// 泰国/柬埔寨银行默认合并进这些 key
const KHQR_ICONS = KHQR_BANKS.map(b => ({ ...b, fallbackUrls: FALLBACK_URL_TEMPLATES }));
const PROMPTPAY_ICONS = PROMPTPAY_BANKS.map(b => ({ ...b, fallbackUrls: FALLBACK_URL_TEMPLATES }));

module.exports = {
  KHQR_ICONS,
  PROMPTPAY_ICONS,
  VIETQR,
  FALLBACK_URL_TEMPLATES,
};
