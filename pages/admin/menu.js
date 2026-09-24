/*
 * pages/admin/menu.js — 菜品+分类管理模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission, L, setMenus, setCategories, dualCurrencyEnabled, secondaryCurrencyCode } = ctx;

const categoryText = c => {
  const cat = (SLF.i18n.dicts[SLF.i18n.lang] && SLF.i18n.dicts[SLF.i18n.lang].categories) || {};
  return cat[c] || c;
};

async function loadMenus() {
  const list = await api('/admin/menu');
  setMenus(list);
  const categoryFilter = $('#menuCategoryFilter') ? $('#menuCategoryFilter').value : 'all';
  let filtered = categoryFilter === 'all' ? list : list.filter(m => m.category === categoryFilter);
  const sortBy = $('#menuSortBy') ? $('#menuSortBy').value : 'default';
  if (sortBy === 'name_asc') filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  else if (sortBy === 'name_desc') filtered = [...filtered].sort((a, b) => b.name.localeCompare(a.name, 'zh'));
  else if (sortBy === 'price_asc') filtered = [...filtered].sort((a, b) => Number(a.price) - Number(b.price));
  else if (sortBy === 'price_desc') filtered = [...filtered].sort((a, b) => Number(b.price) - Number(a.price));
  $('#menus').innerHTML = filtered.length ?
    `<div class="menu-list">${filtered.map(m => {
      let priceDisplay = SLF.money.primary(SLF.money.toBase(m.price, (m.currency_code||'USD')));
      if (dualCurrencyEnabled() && m.secondary_currency_code) {
        const base = SLF.money.toBase(m.price, m.currency_code || 'USD');
        const sec = SLF.money.secondary(base, m.secondary_currency_code);
        if (sec) priceDisplay += ` (${sec})`;
      }
      return `<div class="menu-item-admin ${m.active ? '' : 'inactive'}">
        <div class="menu-thumb">${m.image ? `<img src="/uploads/${esc(m.image)}?v=${Date.now()}">` : esc(m.emoji || '🍽️')}</div>
        <div class="menu-info">
          <div class="name-row"><span class="name">${esc(m.name)}</span><span class="price">${priceDisplay}</span></div>
          <div class="meta">${esc(categoryText(m.category))}${m.desc ? ` · ${esc(m.desc)}` : ''}</div>
        </div>
        <div class="menu-actions">
          ${hasPermission('can_manage_menu') ? '<button onclick="toggleMenuStatus(' + m.id + ',' + (m.active?0:1) + ')">' + (m.active ? tAdmin('unlistDish') : tAdmin('listDish')) + '</button>' : ''}
          ${hasPermission('can_manage_menu') ? '<button class="edit-btn" onclick="editMenu(' + m.id + ')">✏️ ' + L('edit') + '</button>' : ''}
          ${hasPermission('can_manage_menu') ? '<button class="danger" onclick="removeMenu(' + m.id + ')">' + L('delete') + '</button>' : ''}
        </div>
      </div>`;
    }).join('')}</div>` :
    `<div class="empty-hint">${tAdmin('noDishes')}</div>`;
}

async function loadMenuCategories() {
  const list = await api('/menu-categories');
  setCategories(list);
  populateMenuCategorySelect();
  renderCategoryList();
}

function populateMenuCategorySelect() {
  const cats = ctx.categoriesCache();
  const select = $('#menuCategory');
  select.innerHTML = cats.map(c => `<option value="${esc(c.name)}">${esc(categoryText(c.name))}</option>`).join('');
  const filterSelect = $('#menuCategoryFilter');
  if (filterSelect) {
    const currentValue = filterSelect.value;
    filterSelect.innerHTML = '<option value="all">📋 ' + tAdmin('allCategories') + '</option>' +
      cats.map(c => `<option value="${esc(c.name)}">${esc(categoryText(c.name))}</option>`).join('');
    filterSelect.value = currentValue || 'all';
  }
}

function renderCategoryList() {
  const cats = ctx.categoriesCache();
  const box = $('#categoryList');
  box.innerHTML = cats.length ?
    cats.map(c => `<div class="category-row" draggable="true" data-id="${c.id}">
      <span class="name">${esc(categoryText(c.name))}</span>
      <div class="actions"><button onclick="editCategory(${c.id},'${esc(c.name)}')">${L('edit')}</button><button class="danger" onclick="deleteCategory(${c.id})">${L('delete')}</button></div>
    </div>`).join('') :
    `<div class="empty-hint">${tAdmin('noData')}</div>`;
}

// 挂到 window
window.loadMenus = loadMenus;
window.loadMenuCategories = loadMenuCategories;
window.categoryText = categoryText;
window.populateMenuCategorySelect = populateMenuCategorySelect;
window.renderCategoryList = renderCategoryList;

})();
