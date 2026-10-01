/* pages/menu-display.js — 菜品展示页 */
(function(){
'use strict';

const $ = s => document.querySelector(s);
const SUPPORTED = ['zh','en','vi','th','km'];

let currentLang = SLF.store.rawGet('displayLang') || SLF.store.rawGet('lang') || 'zh';
if (!SUPPORTED.includes(currentLang)) currentLang = 'zh';

let allMenu = [];
let currentCat = '__ALL__';
let storeId = 1;
let storeName = 'FoodFlow';
let currencies = [];
let defaultCurrency = { symbol: '$', rate: 1, code: 'USD' };
let dualCurrency = { enabled: false, currency: null };
let clockTimer = null;
let autoRotateTimer = null;
let autoRotateEnabled = true;

function t(key, fb) {
  if (!SLF.i18n) return fb || key;
  const v = SLF.i18n.t(key);
  return (v === undefined || v === null || v === key) ? (fb || key) : v;
}

function catText(cat) {
  if (cat === '__ALL__') return t('all', '全部');
  const lang = SLF.i18n.lang;
  const dict = (SLF.i18n.dicts[lang] && SLF.i18n.dicts[lang].categories) || {};
  if (dict[cat]) return dict[cat];
  const global = (window.LANGUAGES && window.LANGUAGES[lang] && window.LANGUAGES[lang].categories) || {};
  return global[cat] || cat;
}

function menuName(item) {
  if (currentLang === 'zh') return item.name;
  return item['name_' + currentLang] || item.name_en || item.name;
}
function menuDesc(item) {
  if (currentLang === 'zh') return item.desc || '';
  return item['desc_' + currentLang] || item.desc_en || item.desc || '';
}

function startClock() {
  if (clockTimer) return;
  const update = () => {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    $('#dispClock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  update();
  clockTimer = setInterval(update, 1000);
}

function renderCats() {
  const cats = [...new Set(allMenu.map(m => m.category).filter(Boolean))];
  const list = ['__ALL__', ...cats];
  const box = $('#dispCats');
  box.innerHTML = list.map(c =>
    '<button class="disp-cat' + (c === currentCat ? ' active' : '') + '" data-cat="' + c + '">' +
    catText(c) + '</button>'
  ).join('');
  box.querySelectorAll('.disp-cat').forEach(b => {
    b.onclick = () => { currentCat = b.dataset.cat; renderCats(); renderGrid(); resetAutoRotate(); };
  });
  // 保持激活项可见
  const active = box.querySelector('.disp-cat.active');
  if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

function renderGrid() {
  let filtered = currentCat === '__ALL__' ? allMenu : allMenu.filter(m => m.category === currentCat);
  const grid = $('#dispGrid');
  if (!filtered.length) {
    grid.innerHTML = '';
    $('#dispEmpty').style.display = 'block';
    $('#dispEmptyText').textContent = t('noDishes', '暂无菜品');
    $('#dispCount').textContent = '0';
    return;
  }
  $('#dispEmpty').style.display = 'none';
  $('#dispCount').textContent = filtered.length;
  $('#dispCountText').textContent = t('dishes', '道菜品');

  grid.innerHTML = filtered.map((m, idx) => {
    let img;
    if (m.video) {
      img = '<video autoplay muted loop playsinline preload="metadata" poster="' +
            (m.image ? '/uploads/' + m.image : '') + '">' +
            '<source src="/uploads/' + m.video + '"></video>';
    } else if (m.image) {
      img = '<img src="/uploads/' + m.image + '" alt="">';
    } else {
      img = (m.emoji || '🍽️');
    }
    const prices = SLF.money.menuPrice(m);
    let secHtml = '';
    if (prices.secondary) secHtml = '<span class="sec">(' + prices.secondary + ')</span>';
    const hot = (Number(m.sales_count) || 0) > 0 ? '<span class="disp-badge">🔥 ' + t('hotSelling', '热销') + '</span>' : '';
    return '<div class="disp-card" style="animation-delay:' + (idx * 30) + 'ms">' +
      '<div class="disp-thumb-wrap">' + hot + '<div class="disp-thumb">' + img + '</div></div>' +
      '<div class="disp-info">' +
        '<div class="disp-name">' + (menuName(m) || '') + '</div>' +
        '<div class="disp-desc">' + (menuDesc(m) || '') + '</div>' +
        '<div class="disp-price">' + prices.primary + secHtml + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function resetAutoRotate() {
  if (autoRotateTimer) clearInterval(autoRotateTimer);
  if (!autoRotateEnabled) return;
  autoRotateTimer = setInterval(() => {
    const cats = [...new Set(allMenu.map(m => m.category).filter(Boolean))];
    if (cats.length < 2) return;
    const list = ['__ALL__', ...cats];
    const i = list.indexOf(currentCat);
    currentCat = list[(i + 1) % list.length];
    renderCats();
    renderGrid();
  }, 15000);
}

async function loadData() {
  // store_id 优先从 URL 拿
  const params = new URLSearchParams(location.search);
  storeId = parseInt(params.get('store') || '1', 10) || 1;

  try {
    const cfg = await SLF.api.get('/public/config?store_id=' + storeId);
    currencies = cfg.currencies || [];
    defaultCurrency = cfg.defaultCurrency || defaultCurrency;
    dualCurrency = cfg.dualCurrency || dualCurrency;
    SLF.money.configure({ currencies, defaultCurrency, dualCurrency });
  } catch (e) { console.warn('config load failed', e); }

  try {
    const info = await SLF.api.get('/public/store-info?store_id=' + storeId);
    if (info && info.name) storeName = info.name;
  } catch (e) {}
  $('#dispStoreName').textContent = storeName;

  try {
    const data = await SLF.api.get('/menu?store_id=' + storeId);
    allMenu = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn('menu load failed', e);
    allMenu = [];
  }

  renderCats();
  renderGrid();
  resetAutoRotate();
}

async function changeDispLang(lang) {
  if (!SUPPORTED.includes(lang)) return;
  currentLang = lang;
  SLF.store.rawSet('displayLang', lang);
  SLF.store.rawSet('lang', lang);
  await SLF.i18n.init(lang);
  // 更新静态文案
  $('#dispEmptyText').textContent = t('noDishes', '暂无菜品');
  $('#dispCountText').textContent = t('dishes', '道菜品');
  renderCats();
  renderGrid();
}

function toggleDispFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}

async function init() {
  await SLF.i18n.init(currentLang);
  $('#dispLang').value = currentLang;
  startClock();
  await loadData();

  // 5 分钟刷新一次菜单（大屏长挂场景）
  setInterval(loadData, 5 * 60 * 1000);
}

window.changeDispLang = changeDispLang;
window.toggleDispFullscreen = toggleDispFullscreen;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
