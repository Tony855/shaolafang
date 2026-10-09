/* ============================================================
   server/config/khqr-banks.js — KHQR 银行识别配置

   ★ 加新银行 / 改识别关键词 / 换图标 → 只改这个文件
   ★ 前端 pages/khqr-shared.js 会自动从 /api/public/khqr/banks 拉取
   ============================================================ */

/**
 * 银行识别规则
 * - keywords：匹配 bakongId 里的关键词（小写，包含匹配）
 * - 顺序敏感：从上到下依次匹配，第一个匹配的胜出
 */
const BANKS = [
  { name: 'ABA',       keywords: ['@abaa', 'abaakhpp', 'aba'], icon: 'aba.png' },
  { name: 'ACLEDA',    keywords: ['@aclb', 'acleda'],          icon: 'acleda.png' },
  { name: 'Wing',      keywords: ['@wing', 'wing'],            icon: 'Wing.png' },
  { name: 'Bakong',    keywords: ['bakong'],                   icon: 'KHQR.png' },
  { name: 'Chip Mong', keywords: ['@chipmong', 'chipmong'],    icon: 'KHQR.png' },
];

/** 未识别时的默认银行 */
const DEFAULT_BANK = { name: 'Other', icon: 'KHQR.png' };

/**
 * 从 bakongId 识别银行
 * @param {string} bakongId - 例如 'abaakhppxxx@abaa' 或 'khqr@aclb'
 * @returns {{ name: string, icon: string }}
 */
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

/** 银行名 → 图标文件名 映射（给前端用） */
function getBankIconMap() {
  const map = {};
  for (const b of BANKS) map[b.name] = b.icon;
  map[DEFAULT_BANK.name] = DEFAULT_BANK.icon;
  return map;
}

/** 所有银行名列表 */
function getAllBankNames() {
  return BANKS.map(b => b.name);
}

module.exports = {
  BANKS,
  DEFAULT_BANK,
  identifyBank,
  getBankIconMap,
  getAllBankNames,
};
