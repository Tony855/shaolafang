/* ============================================================
   server/services/khqr.js

   FoodFlow KHQR Service
   ------------------------------------------------------------
   支持：
   1. ABA P2P KHR
   2. ABA P2P USD
   3. ABA PayWay
   4. Bakong / KHQR 基础结构
   5. 静态 KHQR 图片解析
   6. 静态码 -> 动态金额二维码
   7. CRC16-CCITT
   8. 嵌套 TLV 解析
   9. PayWay Tag 62 -> 68 结构
   10. ABA P2P Tag 40 结构
   ============================================================ */

const _jimpMod = require('jimp');
const Jimp = _jimpMod.Jimp || _jimpMod;

const jsQR = require('jsqr');


/* ============================================================
   图片读取
   ============================================================ */

async function _readImage(buffer) {
  // Jimp 0.x
  if (typeof Jimp.read === 'function') {
    return await Jimp.read(buffer);
  }

  // Jimp 1.x
  if (typeof Jimp.fromBuffer === 'function') {
    return await Jimp.fromBuffer(buffer);
  }

  throw new Error('Jimp API 不兼容');
}


/* ============================================================
   CRC16-CCITT
   ============================================================ */

function crc16(str) {
  let crc = 0xFFFF;

  const bytes = Buffer.from(String(str), 'utf8');

  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;

    for (let j = 0; j < 8; j++) {
      crc =
        (crc & 0x8000)
          ? ((crc << 1) ^ 0x1021) & 0xFFFF
          : (crc << 1) & 0xFFFF;
    }
  }

  return crc
    .toString(16)
    .toUpperCase()
    .padStart(4, '0');
}


/* ============================================================
   TLV 解析
   ============================================================ */

function parseTLV(payload) {
  const out = [];

  if (payload == null) {
    return out;
  }

  payload = String(payload);

  let i = 0;

  while (i < payload.length) {

    if (i + 4 > payload.length) {
      throw new Error(
        'KHQR TLV 数据不完整：缺少 Tag/Length'
      );
    }

    const tag = payload.slice(i, i + 2);
    const lenText = payload.slice(i + 2, i + 4);

    if (
      !/^\d{2}$/.test(tag) ||
      !/^\d{2}$/.test(lenText)
    ) {
      throw new Error(
        `KHQR TLV 格式错误：tag=${tag}, length=${lenText}`
      );
    }

    const len = Number(lenText);
    const start = i + 4;
    const end = start + len;

    if (end > payload.length) {
      throw new Error(
        `KHQR TLV 长度越界：tag=${tag}, length=${len}, 剩余=${payload.length - start}`
      );
    }

    const value = payload.slice(start, end);

    out.push({ tag, len, value });

    i = end;
  }

  return out;
}


/* ============================================================
   嵌套 TLV
   ============================================================ */

function parseNestedTLV(value) {
  try {
    return parseTLV(value);
  } catch (e) {
    return [];
  }
}


/* ============================================================
   TLV Map
   ============================================================ */

function tlvMap(value) {
  const map = {};

  const items = parseNestedTLV(value);

  for (const item of items) {
    map[item.tag] = item.value;
  }

  return map;
}


/* ============================================================
   解析 Merchant Account Information
   ============================================================ */

function applyAccountInfo(info, value, sourceTag) {
  const sub = parseNestedTLV(value);
  const map = {};

  for (const s of sub) {
    map[s.tag] = s.value;
  }

  if (map['00'] && !info.bakongId) {
    info.bakongId = map['00'];
  }

  if (
    map['01'] &&
    (sourceTag === '29' || sourceTag === '30') &&
    !info.bakongAccount
  ) {
    info.bakongAccount = map['01'];
  }

  if (sourceTag === '40') {
    if (map['00']) {
      info.accountInfo40 = map;
      info.accountType = map['00'];
    }
    if (map['01']) {
      info.bakongP2PId = map['01'];
    }
    if (map['02'] && !info.bakongAccount) {
      info.bakongAccount = map['02'];
    }
  }

  if (sourceTag === '62') {
    let paywayMap = map;

    if (!paywayMap['00']) {
      const nested68 = sub.find(s => s.tag === '68');
      if (nested68) {
        const inner = parseNestedTLV(nested68.value);
        const innerMap = {};
        for (const s of inner) {
          innerMap[s.tag] = s.value;
        }
        if (innerMap['00']) {
          paywayMap = innerMap;
        }
      }
    }

    const type = String(paywayMap['00'] || '').toUpperCase();

    if (type.includes('PAYWAY@ABA')) {
      info.payway = true;
      info.paywayInfo = paywayMap;
      info.accountType = 'PAYWAY';

      if (paywayMap['01']) {
        info.paywayMerchantId = paywayMap['01'];
      }
      if (paywayMap['02']) {
        info.paywayReference = paywayMap['02'];
      }
    }
  }

  return map;
}


/* ============================================================
   从 TLV 提取 KHQR 信息
   ============================================================ */

function extractInfo(tlvs) {
  const info = {
    accountType: '',
    payway: false,
  };

  for (const t of tlvs) {
    switch (t.tag) {
      case '00':
        info.payloadFormat = t.value;
        break;

      case '01':
        info.pointOfInit = t.value;
        break;

      case '53':
        info.currency = t.value;
        break;

      case '54':
        info.amount = t.value;
        break;

      case '59':
        info.merchantName = t.value;
        break;

      case '60':
        info.merchantCity = t.value;
        break;

      case '29':
      case '30':
        applyAccountInfo(info, t.value, t.tag);
        break;

      case '40':
        applyAccountInfo(info, t.value, '40');
        break;

      case '62':
        applyAccountInfo(info, t.value, '62');
        break;

      default:
        break;
    }
  }

  return info;
}


/* ============================================================
   TLV 生成
   ============================================================ */

function tlv(tag, value) {
  value = String(value);
  const len = String(value.length).padStart(2, '0');

  if (value.length > 99) {
    throw new Error(`TLV 字段过长：tag=${tag}, length=${value.length}`);
  }

  return tag + len + value;
}


/* ============================================================
   静态码 -> 动态码
   ============================================================ */

function buildDynamicPayload(staticPayload, amount, currencyCode, orderNo) {
  if (!validateCrc(staticPayload)) {
    throw new Error('静态码 CRC 校验失败');
  }

  const tlvs = parseTLV(staticPayload);

  const clean = tlvs.filter(t => !['54', '63'].includes(t.tag));

  const t62Orig = tlvs.find(t => t.tag === '62');
  const t62Subs = t62Orig ? parseNestedTLV(t62Orig.value) : [];

  for (let i = clean.length - 1; i >= 0; i--) {
    if (clean[i].tag === '62') {
      clean.splice(i, 1);
    }
  }

  const t29 = clean.find(t => t.tag === '29');

  let fullPhone = '';
  let shortPhone = '';

  if (t29) {
    const subs = parseNestedTLV(t29.value);
    const subMap = {};

    for (const sub of subs) {
      subMap[sub.tag] = sub.value;
    }

    fullPhone = String(subMap['01'] || '');

    if (fullPhone && !fullPhone.startsWith('855')) {
      fullPhone = '855' + fullPhone.replace(/^0/, '');
    }

    const t62OrigAgain = tlvs.find(t => t.tag === '62');

    if (t62OrigAgain) {
      const sub62 = parseNestedTLV(t62OrigAgain.value);
      const p02 = sub62.find(s => s.tag === '02');
      if (p02) {
        shortPhone = p02.value;
      }
    }

    if (!shortPhone && fullPhone.startsWith('855')) {
      shortPhone = '0' + fullPhone.slice(3);
    }

    let newT29 = '';

    if (subMap['00']) {
      newT29 += tlv('00', subMap['00']);
    }
    if (shortPhone) {
      newT29 += tlv('01', shortPhone);
    }
    if (subMap['02']) {
      newT29 += tlv('02', subMap['02']);
    }

    t29.value = newT29;

    console.log(
      '[khqr] Tag 29.01 = ' + shortPhone + ' (9位), 完整手机号 = ' + fullPhone
    );
  }

  const t39 = clean.find(t => t.tag === '39');

  if (t39 && fullPhone) {
    const subs39 = parseNestedTLV(t39.value);
    let newT39 = '';

    for (const s of subs39) {
      if (s.tag === '00') {
        newT39 += tlv('00', fullPhone);
      } else {
        newT39 += tlv(s.tag, s.value);
      }
    }

    t39.value = newT39;
  }

  const t01 = clean.find(t => t.tag === '01');

  if (t01) {
    t01.value = '12';
  }

  const wantCurrency = currencyCode === 'KHR' ? '116' : '840';

  const t53 = clean.find(t => t.tag === '53');

  if (t53) {
    t53.value = wantCurrency;
  } else {
    clean.push({ tag: '53', value: wantCurrency });
  }

  let amountStr;

  if (currencyCode === 'KHR') {
    amountStr = String(Math.round(Number(amount)));
  } else {
    amountStr = Number(amount).toFixed(2);
  }

  let t62Value = '';

  const isPayWay = tlvs.some(t => {
    if (t.tag !== '62') {
      return false;
    }

    const subs = parseNestedTLV(t.value);

    if (
      subs.some(
        s =>
          s.tag === '00' &&
          String(s.value).toUpperCase().includes('PAYWAY@ABA')
      )
    ) {
      return true;
    }

    const tag68 = subs.find(s => s.tag === '68');
    if (!tag68) {
      return false;
    }

    const inner = parseNestedTLV(tag68.value);

    return inner.some(
      s =>
        s.tag === '00' &&
        String(s.value).toUpperCase().includes('PAYWAY@ABA')
    );
  });

  if (isPayWay) {
    for (const sub of t62Subs) {
      t62Value += tlv(sub.tag, sub.value);
    }

    if (orderNo && !t62Subs.some(s => s.tag === '08')) {
      t62Value += tlv('08', 'Order ' + orderNo);
    }
  } else {
    for (const sub of t62Subs) {
      if (sub.tag !== '01' && sub.tag !== '08') {
        t62Value += tlv(sub.tag, sub.value);
      }
    }

    if (orderNo) {
      t62Value += tlv('01', orderNo);
      t62Value += tlv('08', 'Order ' + orderNo);
    }
  }

  const nowMs = Date.now();
  const expireMs = nowMs + 10 * 60 * 1000;

  let t99Value = '';

  t99Value += tlv('00', String(nowMs));
  t99Value += tlv('01', String(expireMs));

  const parts = [];
  let inserted54 = false;

  for (const t of clean) {
    parts.push(tlv(t.tag, t.value));

    if (t.tag === '53' && !inserted54) {
      parts.push(tlv('54', amountStr));
      inserted54 = true;
    }
  }

  if (!inserted54) {
    parts.push(tlv('54', amountStr));
  }

  if (t62Value) {
    parts.push(tlv('62', t62Value));
  }

  if (t99Value) {
    parts.push(tlv('99', t99Value));
  }

  parts.sort(
    (a, b) => parseInt(a.slice(0, 2), 10) - parseInt(b.slice(0, 2), 10)
  );

  const body = parts.join('') + '6304';
  const crc = crc16(body);

  return body + crc;
}


/* ============================================================
   从图片 Buffer 解析二维码
   ============================================================ */

// 图片解码已抽到 server/services/qr-image.js，供 KHQR/VietQR 共用
const { decodeQRFromImage } = require('./qr-image');


/* ============================================================
   CRC 校验
   ============================================================ */

function validateCrc(payload) {
  if (!payload || payload.length < 8) {
    return false;
  }

  const body = payload.slice(0, -4);
  const expected = payload.slice(-4).toUpperCase();

  return crc16(body) === expected;
}


/* ============================================================
   静态 KHQR 图片解析
   ============================================================ */

async function parseAndValidateStaticQR(buffer) {
  const payload = await decodeQRFromImage(buffer);

  if (!validateCrc(payload)) {
    throw new Error('二维码不是有效的 KHQR（CRC 校验失败）');
  }

  const tlvs = parseTLV(payload);
  const info = extractInfo(tlvs);

  if (info.payloadFormat !== '01') {
    throw new Error('非 KHQR 标准二维码');
  }

  if (!info.currency || !['840', '116'].includes(info.currency)) {
    throw new Error('二维码币种无效（需 USD 或 KHR）');
  }

  if (!info.merchantName) {
    throw new Error('未读取到收款人名称');
  }

  if (!info.bakongId && !info.bakongAccount && !info.paywayMerchantId) {
    throw new Error(
      '未读取到 ABA/Bakong 收款账户信息 (tag: ' +
      tlvs.map(t => t.tag).join(',') +
      ')'
    );
  }

  if (info.pointOfInit !== '11') {
    throw new Error('请上传未带金额的静态收款码（非账单码）');
  }

  const currency = info.currency === '840' ? 'USD' : 'KHR';

  return {
    payload,
    info,
    currency,
    merchantName: info.merchantName,
    bakongId: info.bakongId || '',
    accountType: info.accountType || (info.payway ? 'PAYWAY' : 'P2P'),
    payway: !!info.payway,
    paywayMerchantId: info.paywayMerchantId || '',
    paywayReference: info.paywayReference || '',
    bakongAccount: info.bakongAccount || '',
    bakongP2PId: info.bakongP2PId || '',
    merchantCity: info.merchantCity || '',
  };
}


/* ============================================================
   原始 Payload 解析
   ============================================================ */

function parseStaticPayload(payload) {
  if (!payload || typeof payload !== 'string') {
    throw new Error('KHQR payload 必须是字符串');
  }

  if (!validateCrc(payload)) {
    throw new Error('KHQR payload CRC 校验失败');
  }

  const tlvs = parseTLV(payload);
  const info = extractInfo(tlvs);

  return {
    payload,
    tlvs,
    info,
    currency:
      info.currency === '840' ? 'USD' : (info.currency === '116' ? 'KHR' : ''),
    merchantName: info.merchantName || '',
    bakongId: info.bakongId || '',
    bakongAccount: info.bakongAccount || '',
    accountType: info.accountType || (info.payway ? 'PAYWAY' : 'P2P'),
    payway: !!info.payway,
    paywayMerchantId: info.paywayMerchantId || '',
    paywayReference: info.paywayReference || '',
  };
}


/* ============================================================
   Module Exports
   ============================================================ */

module.exports = {
  crc16,
  validateCrc,
  parseTLV,
  parseStaticPayload,
  extractInfo,
  decodeQRFromImage,
  buildDynamicPayload,
  parseAndValidateStaticQR,
};
