/* pages/menu-display.js — 菜品展示页（网格 / 单菜轮播） */
(function(){
'use strict';
const $ = s => document.querySelector(s);
const SUPPORTED = ['zh','en','vi','th','km'];
let currentLang = SLF.store.rawGet('displayLang') || SLF.store.rawGet('lang') || 'zh';
if (!SUPPORTED.includes(currentLang)) currentLang = 'zh';
let allMenu = [], filtered = [];
let currentCat = '__ALL__';
let storeId = 1, storeName = 'FoodFlow';
let currencies = [];
let defaultCurrency = { symbol: '$', rate: 1, code: 'USD' };
let dualCurrency = { enabled: false, currency: null };
let clockTimer = null;
let settings = { mode:'grid', image_duration:8, video_mode:'full', video_duration:15, order:'default', only_active:1, show_price:1, show_desc:1, languages:'["zh"]' };
let carIdx = 0, carTimer = null;

function t(key, fb){ if(!SLF.i18n) return fb||key; const v=SLF.i18n.t(key); return (v===undefined||v===null||v===key)?(fb||key):v; }
function catText(cat){
  if (cat === '__ALL__') return t('all','全部');
  const lang = SLF.i18n.lang;
  const dict = (SLF.i18n.dicts[lang] && SLF.i18n.dicts[lang].categories) || {};
  if (dict[cat]) return dict[cat];
  const global = (window.LANGUAGES && window.LANGUAGES[lang] && window.LANGUAGES[lang].categories) || {};
  return global[cat] || cat;
}
function menuName(item){ return menuNameAll(item)[0] || item.name || ''; }
function parseLanguages(){
  try { const a = JSON.parse(settings.languages || '["zh"]'); return Array.isArray(a) && a.length ? a : ['zh']; }
  catch (e) { return ['zh']; }
}
function menuNameAll(item){
  const langs = parseLanguages(); const out = [];
  langs.forEach(lang => {
    let v = '';
    if (lang === 'zh') v = item.name || '';
    else v = item['name_' + lang] || (lang === 'en' ? item.name_en : '') || '';
    v = (v || '').trim();
    if (v && !out.includes(v)) out.push(v);
  });
  return out.length ? out : [item.name || ''];
}
function menuDescAll(item){
  const langs = parseLanguages(); const out = [];
  langs.forEach(lang => {
    let v = '';
    if (lang === 'zh') v = item.desc || '';
    else v = item['desc_' + lang] || (lang === 'en' ? item.desc_en : '') || '';
    v = (v || '').trim();
    if (v && !out.includes(v)) out.push(v);
  });
  return out;
}
function menuDesc(item){ return currentLang==='zh' ? (item.desc||'') : (item['desc_'+currentLang] || item.desc_en || item.desc || ''); }
function startClock(){
  if (clockTimer) return;
  const update = () => { const d=new Date(); const p=n=>String(n).padStart(2,'0'); const el=$('#dispClock'); if(el) el.textContent=p(d.getHours())+':'+p(d.getMinutes()); };
  update(); clockTimer = setInterval(update, 1000);
}
function applyOrder(list){
  const arr = [...list];
  if (settings.order === 'sales') arr.sort((a,b)=>(Number(b.sales_count)||0)-(Number(a.sales_count)||0));
  else if (settings.order === 'random') for (let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr;
}
function renderCats(){
  const cats = [...new Set(allMenu.map(m=>m.category).filter(Boolean))];
  const list = ['__ALL__', ...cats];
  const box = $('#dispCats'); if(!box) return;
  box.innerHTML = list.map(c=>'<button class="disp-cat'+(c===currentCat?' active':'')+'" data-cat="'+c+'">'+catText(c)+'</button>').join('');
  box.querySelectorAll('.disp-cat').forEach(b=>{ b.onclick=()=>{ currentCat=b.dataset.cat; renderCats(); applyFilterAndRender(); }; });
  const active = box.querySelector('.disp-cat.active');
  if (active) active.scrollIntoView({behavior:'smooth',block:'nearest',inline:'center'});
}
function cardHtml(m){
  let media;
  if (m.video) media = '<video autoplay muted loop playsinline preload="metadata"'+(m.image?' poster="/uploads/'+m.image+'"':'')+'><source src="/uploads/'+m.video+'"></video>';
  else if (m.image) media = '<img src="/uploads/'+m.image+'" alt="">';
  else media = (m.emoji || '🍽️');
  const prices = SLF.money.menuPrice(m);
  let secHtml = prices.secondary ? '<span class="sec">('+prices.secondary+')</span>' : '';
  const hot = (Number(m.sales_count)||0)>0 ? '<span class="disp-badge">🔥 '+t('hotSelling','热销')+'</span>' : '';
  const priceRow = settings.show_price ? '<div class="disp-price">'+prices.primary+secHtml+'</div>' : '';
  const names = menuNameAll(m);
  const nameHtml = names.map((n, i) => '<div class="disp-name' + (i > 0 ? ' disp-name-sub' : '') + '">' + n + '</div>').join('');
  const descs = menuDescAll(m);
  const descHtml = (settings.show_desc && descs.length) ? descs.map((d, i) => '<div class="disp-desc' + (i > 0 ? ' disp-desc-sub' : '') + '">' + d + '</div>').join('') : '';
  return '<div class="disp-thumb-wrap">'+hot+'<div class="disp-thumb">'+media+'</div></div>'+
    '<div class="disp-info">' + nameHtml + descHtml + priceRow + '</div>';
}
function applyFilterAndRender(){
  filtered = currentCat==='__ALL__' ? allMenu : allMenu.filter(m=>m.category===currentCat);
  filtered = applyOrder(filtered);
  document.body.classList.toggle('disp-carousel-mode', settings.mode==='carousel');
  if (settings.mode==='carousel') startCarousel();
  else { stopCarousel(); renderGrid(); }
}
function renderGrid(){
  const grid = $('#dispGrid'); if(!grid) return;
  if (!filtered.length){ grid.innerHTML=''; if($('#dispEmpty')){$('#dispEmpty').style.display='block';$('#dispEmptyText').textContent=t('noDishes','暂无菜品');} if($('#dispCount'))$('#dispCount').textContent='0'; return; }
  if($('#dispEmpty'))$('#dispEmpty').style.display='none';
  if($('#dispCount'))$('#dispCount').textContent=filtered.length;
  if($('#dispCountText'))$('#dispCountText').textContent=t('dishes','道菜品');
  grid.innerHTML = filtered.map((m,idx)=>'<div class="disp-card" style="animation-delay:'+(idx*30)+'ms">'+cardHtml(m)+'</div>').join('');
}
function stopCarousel(){ if(carTimer){clearTimeout(carTimer);carTimer=null;} }
function nextCarousel(){ if(!filtered.length) return; carIdx=(carIdx+1)%filtered.length; showCarousel(carIdx); }
function showCarousel(idx){
  if(!filtered.length) return;
  carIdx = ((idx%filtered.length)+filtered.length)%filtered.length;
  const m = filtered[carIdx];
  const grid = $('#dispGrid'); if(!grid) return;
  grid.innerHTML = '<div class="disp-carousel-card">'+cardHtml(m)+'</div>';
  if($('#dispCount')) $('#dispCount').textContent = (carIdx+1)+' / '+filtered.length;
  const v = grid.querySelector('video');
  if (v) {
    if (settings.video_mode==='full') { v.loop=false; v.onended=()=>nextCarousel(); v.play().catch(()=>{}); stopCarousel(); carTimer=setTimeout(nextCarousel, 5*60*1000); return; }
    else { v.loop=true; v.play().catch(()=>{}); stopCarousel(); carTimer=setTimeout(nextCarousel,(settings.video_duration||15)*1000); return; }
  }
  stopCarousel();
  carTimer = setTimeout(nextCarousel,(settings.image_duration||8)*1000);
}
function startCarousel(){
  stopCarousel();
  if (!filtered.length){ if($('#dispGrid'))$('#dispGrid').innerHTML=''; if($('#dispEmpty')){$('#dispEmpty').style.display='block';$('#dispEmptyText').textContent=t('noDishes','暂无菜品');} return; }
  if($('#dispEmpty'))$('#dispEmpty').style.display='none';
  showCarousel(carIdx);
}
async function loadSettings(){
  try {
    const s = await SLF.api.get('/public/display-page-settings?store_id=' + storeId);
    settings = Object.assign(settings, s || {});
  } catch (e) { console.warn('loadSettings failed', e); }
}
async function loadData(){
  const params = new URLSearchParams(location.search);
  storeId = parseInt(params.get('store') || '1', 10) || 1;

  // 4 个接口并行拉取（原串行耗时 = 4 个之和，现在 = 最慢那个）
  const [cfgRes, infoRes, settingsRes, menuRes] = await Promise.all([
    SLF.api.get('/public/config?store_id=' + storeId).catch(e => null),
    SLF.api.get('/public/store-info?store_id=' + storeId).catch(e => null),
    SLF.api.get('/public/display-page-settings?store_id=' + storeId).catch(e => null),
    SLF.api.get('/menu?store_id=' + storeId).catch(e => null),
  ]);

  // ---- 依次处理（依赖顺序，不能乱）----
  if (cfgRes) {
    currencies = cfgRes.currencies || [];
    defaultCurrency = cfgRes.defaultCurrency || defaultCurrency;
    dualCurrency = cfgRes.dualCurrency || dualCurrency;
    SLF.money.configure({ currencies, defaultCurrency, dualCurrency });
  }
  if (infoRes && infoRes.name) storeName = infoRes.name;
  if ($('#dispStoreName')) $('#dispStoreName').textContent = storeName;
  if (settingsRes) settings = Object.assign(settings, settingsRes || {});

  let list = Array.isArray(menuRes) ? menuRes : [];
  if (settings.only_active) list = list.filter(m => m.active !== 0);
  allMenu = list;

  renderCats();
  applyFilterAndRender();
}
async function changeDispLang(lang){
  if (!SUPPORTED.includes(lang)) return;
  currentLang = lang;
  SLF.store.rawSet('displayLang', lang);
  SLF.store.rawSet('lang', lang);
  await SLF.i18n.init(lang);
  updateDispTitle();
  renderCats();
  applyFilterAndRender();
}

function updateDispTitle(){
  const el = document.getElementById('pageTitle');
  if (!el) return;
  const menuLabel = (SLF.i18n && SLF.i18n.t && SLF.i18n.t('menu')) || 'Menu';
  el.textContent = menuLabel + ' · FoodFlow';
}
function toggleDispFullscreen(){
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(()=>{});
}
async function init(){
  await SLF.i18n.init(currentLang);
  if ($('#dispLang')) $('#dispLang').value = currentLang;
  startClock();
  await loadData();
  document.addEventListener('keydown', e => {
    if (settings.mode !== 'carousel') return;
    if (e.key === 'ArrowRight') { stopCarousel(); nextCarousel(); }
    if (e.key === 'ArrowLeft') { stopCarousel(); carIdx = (carIdx - 2 + filtered.length) % filtered.length; nextCarousel(); }
  });
  setInterval(loadData, 5 * 60 * 1000);
}
window.changeDispLang = changeDispLang;
window.toggleDispFullscreen = toggleDispFullscreen;
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
