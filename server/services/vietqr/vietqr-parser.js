'use strict';

function parseTLV(input) {
  if (typeof input !== 'string') throw new TypeError('TLV input must be a string');
  const fields = [];
  let i = 0;

  while (i < input.length) {
    if (i + 4 > input.length) {
      throw new Error(`Malformed TLV: incomplete tag/length at offset ${i}`);
    }

    const tag = input.slice(i, i + 2);
    const lengthText = input.slice(i + 2, i + 4);

    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) {
      throw new Error(`Malformed TLV tag/length at offset ${i}`);
    }

    const length = Number(lengthText);
    const valueStart = i + 4;
    const valueEnd = valueStart + length;

    if (valueEnd > input.length) {
      throw new Error(`Malformed TLV: tag ${tag} declares ${length} chars but payload ends early`);
    }

    fields.push({
      tag,
      length,
      value: input.slice(valueStart, valueEnd),
      offset: i
    });
    i = valueEnd;
  }

  return fields;
}

function fieldMap(fields) {
  const out = Object.create(null);
  for (const field of fields) {
    if (!(field.tag in out)) out[field.tag] = [];
    out[field.tag].push(field);
  }
  return out;
}

function first(map, tag) {
  return map[tag] && map[tag].length ? map[tag][0].value : null;
}

function crc16CcittFalse(buffer) {
  let crc = 0xFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function findNestedAccount(accountInfo) {
  let outer;
  try {
    outer = fieldMap(parseTLV(accountInfo));
  } catch {
    return { guid: null, bankBin: null, accountNumber: null, serviceCode: null, nestedFields: [] };
  }

  const guid = first(outer, '00');
  const beneficiaryRaw = first(outer, '01');
  const serviceCode = first(outer, '02');

  let beneficiary = [];
  let beneficiaryMap = Object.create(null);
  if (beneficiaryRaw !== null) {
    try {
      beneficiary = parseTLV(beneficiaryRaw);
      beneficiaryMap = fieldMap(beneficiary);
    } catch {
      // Keep partial result; variant may use a provider-specific layout.
    }
  }

  return {
    guid,
    bankBin: first(beneficiaryMap, '00'),
    accountNumber: first(beneficiaryMap, '01'),
    serviceCode,
    nestedFields: beneficiary
  };
}

function parseVietQR(payload) {
  if (typeof payload !== 'string' || payload.trim() === '') {
    throw new TypeError('payload must be a non-empty string');
  }

  const raw = payload.trim();
  const fields = parseTLV(raw);
  const map = fieldMap(fields);

  const accountInfo = first(map, '38');
  const account = accountInfo === null
    ? { guid: null, bankBin: null, accountNumber: null, serviceCode: null, nestedFields: [] }
    : findNestedAccount(accountInfo);

  const crcField = fields.find(f => f.tag === '63');
  let crcValid = null;
  let crcExpected = null;
  let crcCalculated = null;

  if (crcField && crcField.value.length === 4) {
    crcExpected = crcField.value.toUpperCase();
    const crcInput = raw.slice(0, crcField.offset + 4);
    crcCalculated = crc16CcittFalse(crcInput);
    crcValid = crcCalculated === crcExpected;
  }

  const amountText = first(map, '54');
  const amount = amountText !== null && /^\d+(\.\d+)?$/.test(amountText)
    ? Number(amountText)
    : null;

  const currencyCode = first(map, '53');
  const countryCode = first(map, '58');
  const method = first(map, '01');
  const guid = account.guid;

  return {
    format: guid === 'A000000727' ? 'VIETQR_NAPAS' : 'EMVCO_QR',
    payloadFormat: first(map, '00'),
    initiationMethod: method,
    qrType: method === '12' ? 'DYNAMIC' : method === '11' ? 'STATIC' : 'UNKNOWN',
    bank: {
      bin: account.bankBin,
      accountNumber: account.accountNumber,
      serviceCode: account.serviceCode
    },
    payment: {
      amount,
      currencyCode,
      currency: currencyCode === '704' ? 'VND' : null,
      country: countryCode,
      purpose: (() => {
        const additional = first(map, '62');
        if (additional === null) return null;
        try {
          return first(fieldMap(parseTLV(additional)), '08');
        } catch {
          return null;
        }
      })()
    },
    merchantName: first(map, '59'),
    crc: {
      expected: crcExpected,
      calculated: crcCalculated,
      valid: crcValid
    },
    paymentStatus: 'UNVERIFIED',
    rawPayload: raw,
    fields: fields.map(({ tag, length, value }) => ({ tag, length, value }))
  };
}

module.exports = { parseTLV, crc16CcittFalse, parseVietQR };
