/*
 * SLF.money — 货币换算与价格格式化
 *
 * 新模型（3 个概念）：
 *   base       —— 系统内部基准（USD），不可见
 *   primary    —— 显示给顾客的主货币（默认 USD，可改 KHR）
 *   secondary  —— 副货币（可选，空=关闭双币）
 *
 * configure({ currencies, primaryCurrency, secondaryCurrency })
 */
(function (global) {
  'use strict';
  var SLF = global.SLF = global.SLF || {};

  var currencies = [];
  var primaryCur = { code: 'USD', symbol: '$', rate: 1 };
  var secondaryCur = null;

  function configure(cfg) {
    cfg = cfg || {};
    if (Array.isArray(cfg.currencies)) currencies = cfg.currencies;

    // 主币
    if (cfg.primaryCurrency) primaryCur = cfg.primaryCurrency;
    // 兼容旧字段
    else if (cfg.defaultCurrency) primaryCur = cfg.defaultCurrency;

    // 副币：null/空 = 关闭
    if (cfg.secondaryCurrency !== undefined) {
      secondaryCur = cfg.secondaryCurrency || null;
    } else if (cfg.dualCurrency && cfg.dualCurrency.enabled && cfg.dualCurrency.currency) {
      secondaryCur = cfg.dualCurrency.currency;
    } else {
      secondaryCur = null;
    }

    return SLF.money;
  }

  function find(code) {
    for (var i = 0; i < currencies.length; i++) if (currencies[i].code === code) return currencies[i];
    return null;
  }

  // 任意币种价格 → USD base
  function toBase(price, code) {
    if (!code) return Number(price || 0);
    var c = find(code);
    if (!c || !c.rate) return Number(price || 0);
    return Number(price || 0) / Number(c.rate);
  }

  // base(USD) → 主币显示串
  function primary(base) {
    var sym = primaryCur.symbol || '$';
    var rate = Number(primaryCur.rate || 1);
    return sym + (Number(base || 0) * rate).toFixed(2);
  }

  // base(USD) → 指定副币显示串
  function secondary(base, code) {
    if (!code) return '';
    var sc = find(code);
    if (!sc) return '';
    var rate = Number(sc.rate || 1);
    return (sc.symbol || '') + (Number(base || 0) * rate).toFixed(2);
  }

  // base → '主币 (副币)' 或 '主币'
  function format(base, opts) {
    opts = opts || {};
    var p = primary(base);
    var secCode = opts.secondaryCode;
    if (secCode === undefined) secCode = secondaryCur ? secondaryCur.code : null;
    var secStr = secCode ? secondary(base, secCode) : '';
    return secStr ? p + ' (' + secStr + ')' : p;
  }

  // 菜品价格：返回 { primary, secondary }
  function menuPrice(item) {
    var base = toBase(item.price, item.currency_code);
    var p = primary(base);
    var secStr = '';
    if (secondaryCur) secStr = secondary(base, secondaryCur.code);
    return { primary: p, secondary: secStr };
  }

  // 返回 HTML 字符串：主货币红色 + 副货币灰色（括号内）
  function formatHtml(base) {
    var p = primary(base);
    var d = secondaryCur;
    var sec = d ? secondary(base, d.code) : '';
    return sec
      ? '<span class="money-primary">' + p + '</span> <span class="money-secondary">(' + sec + ')</span>'
      : '<span class="money-primary">' + p + '</span>';
  }

  SLF.money = {
    configure: configure,
    formatHtml: formatHtml,
    toBase: toBase,
    primary: primary,
    secondary: secondary,
    format: format,
    menuPrice: menuPrice,
    find: find
  };

  Object.defineProperty(SLF.money, 'currencies', { get: function () { return currencies; } });
  Object.defineProperty(SLF.money, 'primaryCurrency', { get: function () { return primaryCur; } });
  Object.defineProperty(SLF.money, 'secondaryCurrency', { get: function () { return secondaryCur; } });
  // 兼容旧 getter
  Object.defineProperty(SLF.money, 'default', { get: function () { return primaryCur; } });
  Object.defineProperty(SLF.money, 'dual', {
    get: function () {
      return { enabled: !!secondaryCur, currency: secondaryCur };
    }
  });
})(window);
