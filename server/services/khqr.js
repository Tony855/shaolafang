/* ============================================================
   server/services/khqr.js — KHQR 动态码生成 + 静态码解析
   ============================================================ */
const _jimpMod = require('jimp');
const Jimp = _jimpMod.Jimp || _jimpMod;

async function _readImage(buffer) {
  // 旧版 v0.x: Jimp.read(buffer)
  if (typeof Jimp.read === 'function') return await Jimp.read(buffer);
  // 新版 v1.x: Jimp.fromBuffer(buffer)
  if (typeof Jimp.fromBuffer === 'function') return await Jimp.fromBuffer(buffer);
  throw new Error('Jimp API 不兼容');
}
const jsQR = require('jsqr');

/* ---------- CRC16-CCITT ---------- */
function crc16(str) {
  let crc = 0xFFFF;
  const bytes = Buffer.from(str, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/* ---------- TLV 解析 ---------- */
function parseTLV(payload) {
  const out = [];
  let i = 0;
  while (i + 4 <= payload.length) {
    const tag = payload.slice(i, i + 2);
    const len = parseInt(payload.slice(i + 2, i + 4), 10);
    if (isNaN(len)) break;
    const value = payload.slice(i + 4, i + 4 + len);
    out.push({ tag, len, value });
    i += 4 + len;
  }
  return out;
}

/* ---------- 校验 CRC ---------- */
function validateCrc(payload) {
  if (payload.length < 8) return false;
  const body = payload.slice(0, -4);
  const expected = payload.slice(-4).toUpperCase();
  return crc16(body) === expected;
}

/* ---------- 从 TLV 数组提取关键字段 ---------- */
function extractInfo(tlvs) {
  const info = {};
  for (const t of tlvs) {
    switch (t.tag) {
      case '00': info.payloadFormat = t.value; break;
      case '01': info.pointOfInit = t.value; break;   // 11=静态 12=动态
      case '53': info.currency = t.value; break;       // 840=USD 116=KHR
      case '54': info.amount = t.value; break;
      case '59': info.merchantName = t.value; break;
      case '60': info.merchantCity = t.value; break;
      case '29':
      case '30':
      case '15':
        // Bakong Account Info（子 TLV）
        {
          const sub = parseTLV(t.value);
          for (const s of sub) {
            if (s.tag === '00') info.bakongId = s.value;
            else if (s.tag === '01') info.bakongAccount = s.value;
            else if (s.tag === '02') info.bakongType = s.value;
          }
        }
        break;
    }
  }
  return info;
}

/* ---------- 组装 TLV ---------- */
function tlv(tag, value) {
  const len = String(value.length).padStart(2, '0');
  return tag + len + value;
}

/* ---------- 静态码 → 动态码 ---------- */
function buildDynamicPayload(staticPayload, amount, currencyCode, orderNo) {
  // 1) 校验静态码
  if (!validateCrc(staticPayload)) {
    throw new Error('静态码 CRC 校验失败');
  }
  const tlvs = parseTLV(staticPayload);

  // 2) 删除 54（金额）、63（CRC）
  //    但 62（附加信息）需要保留原始子标签（如电话号码），只删掉旧主条目稍后重建
  const clean = tlvs.filter(t => !['54', '63'].includes(t.tag));
  const t62Orig = tlvs.find(t => t.tag === '62');
  const t62Subs = t62Orig ? parseTLV(t62Orig.value) : [];
  // 从 clean 里移除旧的 62（主条目）
  for (let i = clean.length - 1; i >= 0; i--) {
    if (clean[i].tag === '62') clean.splice(i, 1);
  }

  // 2.5) 标准化 Tag 29.01（9位）+ 修复 Tag 39.00（11位含855）
  const t29 = clean.find(t => t.tag === '29');
  let fullPhone = '';
  let shortPhone = '';

  if (t29) {
    const subs = parseTLV(t29.value);
    const subMap = {};
    for (const sub of subs) subMap[sub.tag] = sub.value;

    // 完整手机号（11位含 855），从原始 29.01 保留
    fullPhone = String(subMap['01'] || '');
    if (fullPhone && !fullPhone.startsWith('855')) {
      fullPhone = '855' + fullPhone.replace(/^0/, '');
    }

    // 9位手机号：优先 Tag 62.02，否则去掉 855 前缀
    const t62Orig = tlvs.find(t => t.tag === '62');
    if (t62Orig) {
      const sub62 = parseTLV(t62Orig.value);
      const p02 = sub62.find(s => s.tag === '02');
      if (p02) shortPhone = p02.value;
    }
    if (!shortPhone && fullPhone.startsWith('855')) {
      shortPhone = '0' + fullPhone.slice(3);
    }

    // 重建 Tag 29（29.01 用 9 位）
    let newT29 = '';
    if (subMap['00']) newT29 += tlv('00', subMap['00']);
    if (shortPhone) newT29 += tlv('01', shortPhone);
    if (subMap['02']) newT29 += tlv('02', subMap['02']);
    t29.value = newT29;

    console.log('[khqr] Tag 29.01 = ' + shortPhone + ' (9位), 完整手机号 = ' + fullPhone);
  }

  // 2.6) 修复 Tag 39.00 = 完整手机号（关键！ACLEDA 官方动态码的做法）
  const t39 = clean.find(t => t.tag === '39');
  if (t39 && fullPhone) {
    const subs39 = parseTLV(t39.value);
    let newT39 = '';
    for (const s of subs39) {
      if (s.tag === '00') newT39 += tlv('00', fullPhone);
      else newT39 += tlv(s.tag, s.value);
    }
    t39.value = newT39;
    console.log('[khqr] Tag 39.00 = ' + fullPhone);
  }

  // 3) 标签 01 → 12（动态）
  const t01 = clean.find(t => t.tag === '01');
  if (t01) t01.value = '12';
  // 4) 标签 53 → 币种（840 USD / 116 KHR）
  const t53 = clean.find(t => t.tag === '53');
  const wantCurrency = currencyCode === 'KHR' ? '116' : '840';
  if (t53) t53.value = wantCurrency;
  else clean.push({ tag: '53', value: wantCurrency });

  // 5) 金额格式化
  const amountStr = currencyCode === 'KHR'
    ? String(Math.round(Number(amount)))
    : Number(amount).toFixed(2);

  // 6) 附加信息 62：保留原始子标签（如 02 电话号码），追加订单号
  let t62Value = '';
  // 保留原始子标签（跳过 01/08，因为要替换成新订单号）
  for (const sub of t62Subs) {
    if (sub.tag !== '01' && sub.tag !== '08') {
      t62Value += tlv(sub.tag, sub.value);
    }
  }
  // 追加新的订单号
  if (orderNo) {
    t62Value += tlv('01', orderNo);            // 子标签 01 = 账单号
    t62Value += tlv('08', 'Order ' + orderNo); // 子标签 08 = 交易用途
  }

  // 6.5) 标签 99：Bakong 动态码必需的时间戳
  const nowMs = Date.now();
  const expireMs = nowMs + 10 * 60 * 1000; // 10 分钟
  let t99Value = '';
  t99Value += tlv('00', String(nowMs));      // 子标签 00 = 创建时间戳（毫秒，ACLEDA 必需）
  t99Value += tlv('01', String(expireMs));   // 子标签 01 = 过期时间戳（毫秒）

  // 7) 重新组装
  const parts = [];
  let inserted54 = false;
  for (const t of clean) {
    parts.push(tlv(t.tag, t.value));
    if (t.tag === '53' && !inserted54) {
      parts.push(tlv('54', amountStr));
      inserted54 = true;
    }
  }
  if (!inserted54) parts.push(tlv('54', amountStr));

  if (t62Value) parts.push(tlv('62', t62Value));
  if (t99Value) parts.push(tlv('99', t99Value));

  // 7.5) 按 Tag 数字升序重排（EMVCo 标准要求）
  //    每个元素形如 '52 04 5999'，提取前 2 位 tag 排序
  parts.sort((a, b) => parseInt(a.slice(0, 2), 10) - parseInt(b.slice(0, 2), 10));

  // 8) 追加 6304 + CRC
  const body = parts.join('') + '6304';
  const crc = crc16(body);
  return body + crc;
}

/* ---------- 从图片 Buffer 解析二维码 ---------- */
async function decodeQRFromImage(buffer) {
  const image = await _readImage(buffer);
  // 缩小处理以加速（最大 1024px）
  if (image.bitmap.width > 1024) image.resize(1024, Jimp.AUTO);

  const { data, width, height } = image.bitmap;
  // jsQR 需要 Uint8ClampedArray
  const pixels = new Uint8ClampedArray(data.buffer || data);
  const result = jsQR(pixels, width, height);
  if (!result) throw new Error('未识别到二维码，请上传清晰的二维码图片');
  return result.data;
}

/* ---------- 验证并解析 KHQR 静态码 ---------- */
async function parseAndValidateStaticQR(buffer) {
  const payload = await decodeQRFromImage(buffer);
  if (!validateCrc(payload)) {
    throw new Error('二维码不是有效的 KHQR（CRC 校验失败）');
  }
  const tlvs = parseTLV(payload);
  const info = extractInfo(tlvs);

  // 基础字段检查
  if (info.payloadFormat !== '01') {
    throw new Error('非 KHQR 标准二维码');
  }
  if (!info.currency || !['840', '116'].includes(info.currency)) {
    throw new Error('二维码币种无效（需 USD 或 KHR）');
  }
  if (!info.merchantName) {
    throw new Error('未读取到收款人名称');
  }
  if (!info.bakongId && !info.bakongAccount) {
    throw new Error('未读取到 Bakong 账户信息 (tag: ' + tlvs.map(t => t.tag).join(',') + ')');
  }

  // 必须是静态码或可改造的动态码
  if (info.pointOfInit !== '11') {
    // 已含金额的动态码：仍然可以使用，但需要去除原金额
    // 为简化，本方案要求上传静态码
    throw new Error('请上传未带金额的静态收款码（非账单码）');
  }

  return {
    payload,
    info,
    currency: info.currency === '840' ? 'USD' : 'KHR',
    merchantName: info.merchantName,
    bakongId: info.bakongId || info.bakongAccount || '',
  };
}

module.exports = {
  crc16,
  parseTLV,
  validateCrc,
  extractInfo,
  buildDynamicPayload,
  decodeQRFromImage,
  parseAndValidateStaticQR,
};
