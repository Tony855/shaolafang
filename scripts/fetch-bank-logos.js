#!/usr/bin/env node
/* ============================================================
   scripts/fetch-bank-logos.js — 一键拉取三国银行 Logo

   用法：
     node scripts/fetch-bank-logos.js                 # 全部国家，跳过已有
     node scripts/fetch-bank-logos.js --force         # 强制重下
     node scripts/fetch-bank-logos.js --only=khqr     # 只跑柬埔寨
     node scripts/fetch-bank-logos.js --only=vietqr   # 只跑越南
     node scripts/fetch-bank-logos.js --only=promptpay # 只跑泰国
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const {
  KHQR_ICONS, PROMPTPAY_ICONS, VIETQR, FALLBACK_URL_TEMPLATES,
} = require('../server/config/bank-logo-sources');

const ICON_DIR = path.join(__dirname, '..', 'assets', 'vendor', 'payment-icons');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ONLY = (args.find(a => a.startsWith('--only=')) || '').replace('--only=', '');

// 图片魔数
const MAGIC = [
  { name: 'PNG',  bytes: [0x89, 0x50, 0x4E, 0x47] },
  { name: 'JPEG', bytes: [0xFF, 0xD8, 0xFF] },
  { name: 'GIF',  bytes: [0x47, 0x49, 0x46] },
  { name: 'ICO',  bytes: [0x00, 0x00, 0x01, 0x00] },
  { name: 'WEBP', bytes: [0x52, 0x49, 0x46, 0x46] },
  { name: 'SVG',  bytes: [0x3C, 0x3F, 0x78, 0x6D] }, // <?xm
];

function detectImage(buf) {
  if (!buf || buf.length < 8) return null;
  for (const m of MAGIC) {
    let ok = true;
    for (let i = 0; i < m.bytes.length; i++) {
      if (buf[i] !== m.bytes[i]) { ok = false; break; }
    }
    if (ok) return m.name;
  }
  // SVG 文本
  const head = buf.slice(0, 200).toString('utf8');
  if (/<svg|<SVG/i.test(head)) return 'SVG';
  return null;
}

// 下载（支持 30x 重定向）
function download(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FoodFlowLogoFetcher/1.0)',
        'Accept': 'image/*,*/*;q=0.8',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (maxRedirects <= 0) return reject(new Error('too many redirects'));
        const loc = res.headers.location;
        if (!loc) return reject(new Error('no location on ' + res.statusCode));
        const nextUrl = loc.startsWith('http') ? loc : new URL(loc, url).toString();
        res.resume();
        return download(nextUrl, maxRedirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// 尝试一个 bank 的所有源
async function fetchBank(bank) {
  const target = path.join(ICON_DIR, bank.icon);

  // 幂等：已存在且大小合理，跳过
  if (!FORCE && fs.existsSync(target)) {
    const sz = fs.statSync(target).size;
    if (sz > 500) {
      return { status: 'skip', reason: `${sz}B 已存在` };
    }
  }

  const urls = bank.fallbackUrls
    ? bank.fallbackUrls.map(t => t.replace(/\{domain\}/g, bank.domain))
    : [];

  const errors = [];
  for (const url of urls) {
    try {
      const buf = await download(url);
      const kind = detectImage(buf);
      if (!kind) {
        errors.push(`${url} → 非图片`);
        continue;
      }
      if (buf.length < 300) {
        errors.push(`${url} → 太小 ${buf.length}B`);
        continue;
      }
      fs.writeFileSync(target, buf);
      return { status: 'ok', size: buf.length, kind, url };
    } catch (e) {
      errors.push(`${url} → ${e.message}`);
    }
  }
  return { status: 'fail', errors };
}

async function fetchVietQR() {
  console.log('\n🇻🇳  拉取 VietQR 官方列表...');
  let json;
  try {
    const buf = await download(VIETQR.apiUrl);
    json = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    console.log('  ❌ 拉取官方 API 失败:', e.message);
    return { ok: 0, skip: 0, fail: 1 };
  }

  const banks = json.data || [];
  console.log(`  官方返回 ${banks.length} 家银行`);

  const binToUrl = {};
  for (const b of banks) {
    if (b.bin && b.logo) binToUrl[String(b.bin)] = b.logo;
  }

  let ok = 0, skip = 0, fail = 0;
  for (const [bin, icon] of Object.entries(VIETQR.binMap)) {
    const target = path.join(ICON_DIR, icon);
    if (!FORCE && fs.existsSync(target) && fs.statSync(target).size > 500) {
      console.log(`  ⏭  ${icon} (已存在)`);
      skip++;
      continue;
    }
    const url = binToUrl[bin];
    if (!url) {
      console.log(`  ⚠️  ${icon}: BIN ${bin} 不在官方列表`);
      fail++;
      continue;
    }
    try {
      const buf = await download(url);
      const kind = detectImage(buf);
      if (!kind) throw new Error('非图片');
      fs.writeFileSync(target, buf);
      console.log(`  ✅ ${icon} (${buf.length}B, ${kind})`);
      ok++;
    } catch (e) {
      console.log(`  ❌ ${icon}: ${e.message}`);
      fail++;
    }
  }
  return { ok, skip, fail };
}

async function fetchBankList(list, country) {
  console.log(`\n🏦  拉取 ${country} 银行 Logo...`);
  let ok = 0, skip = 0, fail = 0;
  for (const bank of list) {
    process.stdout.write(`  ${bank.icon.padEnd(24)} `);
    try {
      const r = await fetchBank(bank);
      if (r.status === 'ok') {
        console.log(`✅ ${r.size}B ${r.kind}`);
        ok++;
      } else if (r.status === 'skip') {
        console.log(`⏭  ${r.reason}`);
        skip++;
      } else {
        console.log(`❌ 全部源失败`);
        r.errors.forEach(e => console.log(`     ${e}`));
        fail++;
      }
    } catch (e) {
      console.log(`❌ ${e.message}`);
      fail++;
    }
  }
  return { ok, skip, fail };
}

async function main() {
  if (!fs.existsSync(ICON_DIR)) {
    fs.mkdirSync(ICON_DIR, { recursive: true });
  }

  console.log('════════════════════════════════════════');
  console.log('  FoodFlow 银行 Logo 拉取工具');
  console.log('  目标目录:', ICON_DIR);
  console.log('  模式:', FORCE ? '强制重下' : '跳过已有', ONLY ? `(仅 ${ONLY})` : '');
  console.log('════════════════════════════════════════');

  let r1 = { ok: 0, skip: 0, fail: 0 };
  let r2 = { ok: 0, skip: 0, fail: 0 };
  let r3 = { ok: 0, skip: 0, fail: 0 };

  if (!ONLY || ONLY === 'khqr') {
    r1 = await fetchBankList(KHQR_ICONS, '柬埔寨 KHQR');
  }
  if (!ONLY || ONLY === 'vietqr') {
    r3 = await fetchVietQR();
  }
  if (!ONLY || ONLY === 'promptpay') {
    r2 = await fetchBankList(PROMPTPAY_ICONS, '泰国 PromptPay');
  }

  console.log('\n════════════════════════════════════════');
  console.log('  汇总');
  console.log('════════════════════════════════════════');
  console.log(`  柬埔寨 KHQR :  ✅ ${r1.ok}  ⏭  ${r1.skip}  ❌ ${r1.fail}`);
  console.log(`  泰国 PromptPay: ✅ ${r2.ok}  ⏭  ${r2.skip}  ❌ ${r2.fail}`);
  console.log(`  越南 VietQR :  ✅ ${r3.ok}  ⏭  ${r3.skip}  ❌ ${r3.fail}`);
  console.log(`  总计        :  ✅ ${r1.ok + r2.ok + r3.ok}  ⏭  ${r1.skip + r2.skip + r3.skip}  ❌ ${r1.fail + r2.fail + r3.fail}`);
  console.log('');
  console.log('  如需强制重下: node scripts/fetch-bank-logos.js --force');
  console.log('  只跑单国:      node scripts/fetch-bank-logos.js --only=khqr');
  console.log('════════════════════════════════════════');
}

main().catch(e => {
  console.error('❌ 脚本异常:', e);
  process.exit(1);
});
