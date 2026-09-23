/*
 * FoodFlow · SLF.money — 货币换算与主/副货币价格格式化（唯一实现）
 * 各页拉到 global-config 后调用 SLF.money.configure({currencies, defaultCurrency, dualCurrency})。
 *
 * 数据约定：currencies 每项 { code, symbol, rate, is_default }，rate = 该币兑基准(USD)汇率。
 *   base(基准/USD) = price / rate
 *   主币显示      = base * defaultCurrency.rate
 *   副币显示      = base / defaultCurrency.rate * secCurrency.rate
 */
(function (global) {
  'use strict';
  var SLF = global.SLF = global.SLF || {};

  var currencies = [];
  var def = { symbol: '$', rate: 1, code: 'USD' };
  var dual = { enabled: false, currency: null };

  function configure(cfg) {
    cfg = cfg || {};
    if (Array.isArray(cfg.currencies)) currencies = cfg.currencies;
    if (cfg.defaultCurrency) def = cfg.defaultCurrency;
    if (cfg.dualCurrency) dual = cfg.dualCurrency;
    // admin 风格：未显式给 defaultCurrency 时从列表挑 is_default
    if (!cfg.defaultCurrency && Array.isArray(cfg.currencies) && cfg.currencies.length) {
      def = cfg.currencies.find(function (c) { return c.is_default; }) || cfg.currencies[0];
    }
    return SLF.money;
  }

  function find(code) {
    for (var i = 0; i < currencies.length; i++) if (currencies[i].code === code) return currencies[i];
    return null;
  }

  // 任意币种价格 → 基准(USD)
  function toBase(price, code) {
    if (!code) return Number(price || 0);
    var c = find(code);
    if (!c || !c.rate) return Number(price || 0);
    return Number(price || 0) / Number(c.rate);
  }

  // 基准价 → 默认主币显示串
  function primary(base) {
    var sym = (def && def.symbol) || '$';
    var rate = Number((def && def.rate) || 1);
    return sym + (Number(base || 0) * rate).toFixed(2);
  }

  // 基准价 → 指定副币显示串（找不到返回 ''）
  function secondary(base, code) {
    if (!code) return '';
    var sc = find(code);
    if (!sc) return '';
    var defaultRate = Number((def && def.rate) || 1);
    var v = (Number(base || 0) / defaultRate) * Number(sc.rate || 1);
    return (sc.symbol || '') + v.toFixed(2);
  }

  // 主币 [+ 副币]；opts: { showSecondary=true, secondaryCode }
  function format(base, opts) {
    opts = opts || {};
    var show = opts.showSecondary !== false;
    var code = opts.secondaryCode;
    if (show && !code && dual.enabled && dual.currency) code = dual.currency.code;
    var sec = code ? secondary(base, code) : '';
    return sec ? primary(base) + ' (' + sec + ')' : primary(base);
  }

  // 菜品价格：返回 { primary, secondary }
  function menuPrice(item) {
    var base = toBase(item.price, item.currency_code);
    var p = primary(base);
    var s = '';
    if (dual.enabled && item.secondary_currency_code) s = secondary(base, item.secondary_currency_code);
    return { primary: p, secondary: s };
  }

  SLF.money = {
    configure: configure,
    toBase: toBase,
    primary: primary,
    secondary: secondary,
    format: format,
    menuPrice: menuPrice,
    find: find
  };
  Object.defineProperty(SLF.money, 'currencies', { get: function () { return currencies; } });
  Object.defineProperty(SLF.money, 'default', { get: function () { return def; } });
  Object.defineProperty(SLF.money, 'dual', { get: function () { return dual; } });
})(window);
