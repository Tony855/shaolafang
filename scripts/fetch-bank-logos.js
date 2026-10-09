#!/usr/bin/env node
/* ============================================================
   scripts/fetch-bank-logos.js — 一键拉取三国银行 Logo
   [修复版] 并发 5 / 5s socket 超时 / 8s 硬超时 / keep-alive

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

// ---------- 并发 / 超时参数 ----------
const CONCURRENCY   = 5;      // 同时下载的银行数
const SOCKET_TIMEOUT = 5000;  // 单个请求 socket 空闲超时
const HARD_TIMEOUT   = 8000;  // 单次 download 总超时（含 DNS/握手）

// ---------- keep-alive 连接池 ----------
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
const httpAgent  = new http.Agent({  keepAlive: true, maxSockets: 10 });

// ---------- 通用并发 map ----------
async function parallelMap(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        results[idx] = { _err: e };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- 图片魔数识别 ----------
const MAGIC = [
  { name: 'PNG',  bytes: [0x89, 0x50, 0x4E, 0x47] },
  { name: 'JPEG', bytes: [0xFF, 0xD8, 0xFF] },
  { name: 'GIF',  bytes: [0x47, 0x49, 0x46] },
  { name: 'ICO',  bytes: [0x00, 0x00, 0x01, 0x00] },
  { name: 'WEBP', bytes: [0x52, 0x49, 0x46, 0x46] },
  { name: 'SVG',  bytes: [0x3C, 0x3F, 0x78, 0x6D] },
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
  const head = buf.slice(0, 200).toString('utf8');
  if (/<svg|<SVG/i.test(head)) return 'SVG';
  return null;
}

// ---------- 下载（带超时 & keep-alive）----------
function download(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const lib = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    let settled = false;
    let hard = null;
    const done = (err, buf) => {
      if (settled) return;
      settled = true;
      if (hard) clearTimeout(hard);
      if (err) reject(err); else resolve(buf);
    };

    const req = lib.get(url, {
      timeout: SOCKET_TIMEOUT,
      agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FoodFlowLogoFetcher/1.0)',
        'Accept': 'image/*,*/*;q=0.8',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (maxRedirects <= 0) { res.resume(); return done(new Error('too many redirects')); }
        const loc = res.headers.location;
        if (!loc) { res.resume(); return done(new Error('no location on ' + res.statusCode)); }
        const nextUrl = loc.startsWith('http') ? loc : new URL(loc, url).toString();
        res.resume();
        return download(nextUrl, maxRedirects - 1).then(
          b => done(null, b),
          e => done(e),
        );
      }
      if (res.statusCode !== 200) {
        res.resume();
        return done(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
      res.on('error', (e) => done(e));
    });

    hard = setTimeout(() => {
      req.destroy(new Error('hard timeout'));
      done(new Error('hard timeout ' + (HARD_TIMEOUT / 1000) + 's'));
    }, HARD_TIMEOUT);

    req.on('timeout', () => { req.destroy(); done(new Error('timeout')); });
    req.on('error', (e) => done(e));
  });
}

// ---------- 尝试一个 bank 的所有源 ----------
async function fetchBank(bank) {
  const target = path.join(ICON_DIR, bank.icon);

  if (!FORCE && fs.existsSync(target)) {
    const sz = fs.statSync(target).size;
    if (sz > 500) return { status: 'skip', reason: `${sz}B 已存在` };
  }

  const urls = bank.fallbackUrls
    ? bank.fallbackUrls.map(t => t.replace(/\{domain\}/g, bank.domain))
    : [];

  const errors = [];
  for (const url of urls) {
    try {
      const buf = await download(url);
      const kind = detectImage(buf);
      if (!kind) { errors.push(`${url} → 非图片`); continue; }
      if (buf.length < 300) { errors.push(`${url} → 太小 ${buf.length}B`); continue; }
      fs.writeFileSync(target, buf);
      return { status: 'ok', size: buf.length, kind, url };
    } catch (e) {
      errors.push(`${url} → ${e.message}`);
    }
  }
  return { status: 'fail', errors };
}

// ---------- 越南：官方列表 + 并发下载 ----------
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
  const entries = Object.entries(VIETQR.binMap);

  await parallelMap(entries, CONCURRENCY, async ([bin, icon]) => {
    const target = path.join(ICON_DIR, icon);
    if (!FORCE && fs.existsSync(target) && fs.statSync(target).size > 500) {
      console.log(`  ⏭  ${icon} (已存在)`);
      skip++; return;
    }
    const url = binToUrl[bin];
    if (!url) {
      console.log(`  ⚠️  ${icon}: BIN ${bin} 不在官方列表`);
      fail++; return;
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
  });

  return { ok, skip, fail };
}

// ---------- 通用：并发拉一批 bank ----------
async function fetchBankList(list, country) {
  console.log(`\n🏦  拉取 ${country} 银行 Logo...  (并发 ${CONCURRENCY})`);
  let ok = 0, skip = 0, fail = 0;

  await parallelMap(list, CONCURRENCY, async (bank) => {
    try {
      const r = await fetchBank(bank);
      if (r.status === 'ok') {
        console.log(`  ✅ ${bank.icon.padEnd(28)} ${r.size}B ${r.kind}`);
        ok++;
      } else if (r.status === 'skip') {
        console.log(`  ⏭  ${bank.icon.padEnd(28)} ${r.reason}`);
        skip++;
      } else {
        console.log(`  ❌ ${bank.icon.padEnd(28)} 全部源失败`);
        r.errors.forEach(e => console.log(`       ${e}`));
        fail++;
      }
    } catch (e) {
      console.log(`  ❌ ${bank.icon.padEnd(28)} ${e.message}`);
      fail++;
    }
  });

  return { ok, skip, fail };
}

// ---------- main ----------
async function main() {
  if (!fs.existsSync(ICON_DIR)) fs.mkdirSync(ICON_DIR, { recursive: true });

  const t0 = Date.now();
  console.log('════════════════════════════════════════');
  console.log('  FoodFlow 银行 Logo 拉取工具 [修复版]');
  console.log('  目标目录:', ICON_DIR);
  console.log('  模式:', FORCE ? '强制重下' : '跳过已有', ONLY ? `(仅 ${ONLY})` : '');
  console.log('  并发:', CONCURRENCY, ' socket 超时:', SOCKET_TIMEOUT + 'ms', ' 硬超时:', HARD_TIMEOUT + 'ms');
  console.log('════════════════════════════════════════');

  let r1 = { ok: 0, skip: 0, fail: 0 };
  let r2 = { ok: 0, skip: 0, fail: 0 };
  let r3 = { ok: 0, skip: 0, fail: 0 };

  if (!ONLY || ONLY === 'khqr')      r1 = await fetchBankList(KHQR_ICONS, '柬埔寨 KHQR');
  if (!ONLY || ONLY === 'vietqr')    r3 = await fetchVietQR();
  if (!ONLY || ONLY === 'promptpay') r2 = await fetchBankList(PROMPTPAY_ICONS, '泰国 PromptPay');

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('\n════════════════════════════════════════');
  console.log('  汇总   (用时 ' + dur + 's)');
  console.log('════════════════════════════════════════');
  console.log(`  柬埔寨 KHQR  :  ✅ ${r1.ok}  ⏭  ${r1.skip}  ❌ ${r1.fail}`);
  console.log(`  泰国 PromptPay: ✅ ${r2.ok}  ⏭  ${r2.skip}  ❌ ${r2.fail}`);
  console.log(`  越南 VietQR  :  ✅ ${r3.ok}  ⏭  ${r3.skip}  ❌ ${r3.fail}`);
  console.log(`  总计        :  ✅ ${r1.ok + r2.ok + r3.ok}  ⏭  ${r1.skip + r2.skip + r3.skip}  ❌ ${r1.fail + r2.fail + r3.fail}`);
  console.log('');
  console.log('  强制重下: node scripts/fetch-bank-logos.js --force');
  console.log('  只跑单国: node scripts/fetch-bank-logos.js --only=khqr');
  console.log('════════════════════════════════════════');
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error('❌ 脚本异常:', e); process.exit(1); });
