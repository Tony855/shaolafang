/* ============================================================
   server/config/khqr-banks.js — KHQR 银行识别配置
   ============================================================ */
'use strict';

const BANKS = [
  { name: 'ABA',          keywords: ['@abaa', 'abaakhpp', 'aba'],  icon: 'aba.png' },
  { name: 'ACLEDA',       keywords: ['@aclb', 'acleda'],           icon: 'acleda.png' },
  { name: 'Wing',         keywords: ['@wing', 'wing'],             icon: 'Wing.png' },
  { name: 'Bakong',       keywords: ['bakong'],                    icon: 'KHQR.png' },
  { name: 'Chip Mong',    keywords: ['@chipmong', 'chipmong'],     icon: 'chipmong.png' },
  { name: 'Canadia',      keywords: ['canadia'],                   icon: 'canadia.png' },
  { name: 'Vattanac',     keywords: ['vattanac'],                  icon: 'vattanac.png' },
  { name: 'Maybank',      keywords: ['maybank'],                   icon: 'maybank.png' },
  { name: 'J Trust Royal',keywords: ['jtrust'],                    icon: 'jtrust.png' },
  { name: 'Sathapana',    keywords: ['sathapana'],                 icon: 'sathapana.png' },
  { name: 'Hattha',       keywords: ['hattha'],                    icon: 'hattha.png' },
  { name: 'CPBank',       keywords: ['cpbank'],                    icon: 'cpbank.png' },
  { name: 'Phillip Bank', keywords: ['phillip'],                   icon: 'phillip.png' },
  { name: 'KB Prasac',    keywords: ['prasac', 'kbprasac'],        icon: 'kbprasac.png' },
  { name: 'PPCBank',      keywords: ['ppcbank'],                   icon: 'ppcbank.png' },
  { name: 'Prince Bank',  keywords: ['prince'],                    icon: 'prince.png' },
  { name: 'FTB',          keywords: ['ftb'],                       icon: 'ftb.png' },
  { name: 'Shinhan KH',   keywords: ['shinhan'],                   icon: 'shinhan.png' },
  { name: 'Woori KH',     keywords: ['woori'],                     icon: 'woori.png' },
  { name: 'Amret',        keywords: ['amret'],                     icon: 'amret.png' },
];

const DEFAULT_BANK = { name: 'Other', icon: 'KHQR.png' };

function identifyBank(bakongId) {
  const id = String(bakongId || '').toLowerCase();
  if (!id) return { ...DEFAULT_BANK };
  for (const bank of BANKS) {
    if (bank.keywords.some(kw => id.includes(kw))) {
      return { name: bank.name, icon: bank.icon };
    }
  }
  return { ...DEFAULT_BANK };
}

module.exports = { BANKS, DEFAULT_BANK, identifyBank };
