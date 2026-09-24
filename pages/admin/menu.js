/*
 * pages/admin/menu.js — 菜品+分类管理模块
 */
(function(){
'use strict';

const ctx = window.SLF.admin;
if (!ctx) return;

const { $, api, tAdmin, esc, hasPermission, L, dualCurrencyEnabled, secondaryCurrencyCode } = ctx;

const categoryText = c => {
  const cat = (SLF.i18n.dicts[SLF.i18n.lang] && SLF.i18n.dicts[SLF.i18n.lang].categories) || {};
  return cat[c] || c;
};

async function loadMenus() {
  const list = await api('/admin/menu');
  ctx.setMenus(list);
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
      if (ctx.dualCurrencyEnabled() && m.secondary_currency_code) {
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
  ctx.setCategories(list);
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

let editingMenuId = null;
let editingCategoryId = null;

function openCategoryModal() { $('#categoryModal').classList.add('open'); loadMenuCategories(); }
function closeCategoryModal() { $('#categoryModal').classList.remove('open'); }

async function addCategory() {
  const name = $('#newCategoryName').value.trim();
  if (!name) { SLF.ui.toast('❌ ' + tAdmin('tableNameRequired')); return; }
  try {
    await api('/menu-categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { name } });
    $('#newCategoryName').value = '';
    await loadMenuCategories();
    SLF.ui.toast('✅ ' + tAdmin('added'));
  } catch (e) { SLF.ui.toast('❌ ' + e.message); }
}

function editCategory(id, oldName) {
  editingCategoryId = id;
  $('#editCategoryName').value = oldName;
  $('#categoryEditModalTitle').textContent = tAdmin('editCategory');
  $('#categoryEditModal').classList.add('open');
  setTimeout(() => $('#editCategoryName').focus(), 100);
}
function closeCategoryEditModal() { $('#categoryEditModal').classList.remove('open'); editingCategoryId = null; }

async function saveCategoryEdit() {
  const name = $('#editCategoryName').value.trim();
  if (!name) { SLF.ui.toast(`⚠️ ${tAdmin('nameRequired')}`); return; }
  try {
    await api('/menu-categories/' + editingCategoryId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { name } });
    closeCategoryEditModal();
    await loadMenuCategories();
    await loadMenus();
    SLF.ui.toast('✅ ' + tAdmin('updated'));
  } catch (e) { SLF.ui.toast('❌ ' + e.message); }
}

function deleteCategory(id) {
  ctx.showConfirm(tAdmin('confirmDelete'), async function() {
    try {
      await api('/menu-categories/' + id, { method: 'DELETE' });
      await loadMenuCategories();
      await loadMenus();
      SLF.ui.toast('✅ ' + tAdmin('deleted'));
    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
  });
}

function openDishModal() {
  editingMenuId = null;
  $('#menuForm').reset();
  $('#menuEmoji').value = '🍖';
  $('#menuSecondaryCurrency').value = '';
  $('#dishModalTitle').textContent = tAdmin('addDish');
  $('#menuSaveButton').textContent = tAdmin('addDish');
  $('#menuCancelButton').hidden = true;
  populateMenuCategorySelect();
  const currencies = ctx.currenciesCache();
  if (currencies.length) {
    const defaultCode = currencies.find(c => c.is_default)?.code || currencies[0].code;
    $('#menuCurrency').value = defaultCode;
  }
  $('#dishModal').classList.add('open');
}

function closeDishModal() { $('#dishModal').classList.remove('open'); cancelMenuEdit(); }

function editMenu(id) {
  const menus = ctx.menusCache();
  const current = menus.find(x => String(x.id) === String(id));
  if (!current) return;
  editingMenuId = id;
  populateMenuCategorySelect();
  $('#menuName').value = current.name;
  $('#menuNameEn').value = current.name_en || '';
  $('#menuPrice').value = current.price;
  $('#menuCategory').value = current.category;
  $('#menuCurrency').value = current.currency_code || 'USD';
  $('#menuUnit').value = current.unit || tAdmin('portion');
  $('#menuSecondaryCurrency').value = current.secondary_currency_code || '';
  $('#menuEmoji').value = current.emoji || '';
  $('#menuDesc').value = current.desc || '';
  $('#menuDescEn').value = current.desc_en || '';
  $('#menuImageFile').value = '';
  $('#dishModalTitle').textContent = tAdmin('menuManage') + ' #' + id;
  $('#menuSaveButton').textContent = L('save');
  $('#menuCancelButton').hidden = false;
  $('#dishModal').classList.add('open');
}

function cancelMenuEdit() {
  editingMenuId = null;
  $('#menuForm').reset();
  $('#menuEmoji').value = '🍖';
  $('#dishModalTitle').textContent = tAdmin('addDish');
  $('#menuSaveButton').textContent = tAdmin('addDish');
  $('#menuCancelButton').hidden = true;
  const currencies = ctx.currenciesCache();
  if (currencies.length) {
    const defaultCode = currencies.find(c => c.is_default)?.code || currencies[0].code;
    $('#menuCurrency').value = defaultCode;
  }
}

function removeMenu(id) {
  ctx.showConfirm(tAdmin('confirmDelete'), async function() {
    try {
      await api('/menu/' + id, { method: 'DELETE' });
      await loadMenus();
      SLF.ui.toast('✅ ' + tAdmin('deleted'));
    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
  });
}

async function toggleMenuStatus(id, active) {
  try {
    await api('/menu/' + id + '/status', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { active } });
    await loadMenus();
    SLF.ui.toast('✅ ' + (active ? tAdmin('listed') : tAdmin('unlisted')));
  } catch (e) { SLF.ui.toast('❌ ' + e.message); }
}

document.addEventListener('DOMContentLoaded', function() {
  const menuForm = document.getElementById('menuForm');
  if (menuForm) {
    menuForm.onsubmit = async function(e) {
      e.preventDefault();
      try {
        const isEditing = Boolean(editingMenuId);
        const form = new FormData();
        [
          ['name', 'menuName'], ['name_en', 'menuNameEn'], ['price', 'menuPrice'],
          ['category', 'menuCategory'], ['currency_code', 'menuCurrency'],
          ['emoji', 'menuEmoji'], ['desc', 'menuDesc'], ['desc_en', 'menuDescEn'],
          ['unit', 'menuUnit'], ['secondary_currency_code', 'menuSecondaryCurrency']
        ].forEach(([k, id]) => {
          const el = $('#' + id);
          form.append(k, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
        });
        form.append('show_dual', $('#menuSecondaryCurrency').value ? '1' : '0');
        const file = $('#menuImageFile').files[0];
        if (file) {
          try {
            const dataUrl = await new Promise((res, rej) => {
              const fr = new FileReader();
              fr.onload = () => res(fr.result);
              fr.onerror = rej;
              fr.readAsDataURL(file);
            });
            const img = await new Promise((res, rej) => {
              const im = new Image();
              im.onload = () => res(im);
              im.onerror = rej;
              im.src = dataUrl;
            });
            const canvas = document.createElement('canvas');
            const maxW = 800, maxH = 800;
            let w = img.width, h = img.height;
            if (w > maxW) { h = h * maxW / w; w = maxW; }
            if (h > maxH) { w = w * maxH / h; h = maxH; }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            form.set('image', canvas.toDataURL('image/jpeg', 0.85));
          } catch (imgErr) { console.warn('图片压缩失败:', imgErr); }
        }
        await api(isEditing ? '/menu/' + editingMenuId : '/menu', {
          method: isEditing ? 'PUT' : 'POST',
          body: form
        });
        closeDishModal();
        await loadMenus();
        SLF.ui.toast('✅ ' + tAdmin('saved'));
      } catch (e) { SLF.ui.toast('❌ ' + e.message); }
    };
  }
});

// 挂到 window
window.loadMenus = loadMenus;
window.loadMenuCategories = loadMenuCategories;
window.categoryText = categoryText;
window.populateMenuCategorySelect = populateMenuCategorySelect;
window.renderCategoryList = renderCategoryList;
window.openCategoryModal = openCategoryModal;
window.closeCategoryModal = closeCategoryModal;
window.addCategory = addCategory;
window.editCategory = editCategory;
window.closeCategoryEditModal = closeCategoryEditModal;
window.saveCategoryEdit = saveCategoryEdit;
window.deleteCategory = deleteCategory;
window.openDishModal = openDishModal;
window.closeDishModal = closeDishModal;
window.editMenu = editMenu;
window.cancelMenuEdit = cancelMenuEdit;
window.removeMenu = removeMenu;
window.toggleMenuStatus = toggleMenuStatus;

// ===== 批量导入 =====
let importItems = [];

function openImportModal() {
  document.getElementById('importModal').hidden = false;
  document.getElementById('importFile').value = '';
  document.getElementById('importPreview').innerHTML = '';
  document.getElementById('importResult').innerHTML = '';
  document.getElementById('confirmImportBtn').disabled = true;
  
  // 多语言
  const lang = SLF.i18n.lang || 'zh';
  const texts = {
    zh: {
      title: '📥 批量导入菜品',
      desc: '选择 CSV 文件导入菜品，格式：name,category,price,emoji,desc,name_en,desc_en',
      downloadTpl: '📥 下载模板',
      cancel: '取消',
      startImport: '开始导入',
      importing: '导入中...'
    },
    en: {
      title: '📥 Batch Import Menu',
      desc: 'Select CSV file to import. Format: name,category,price,emoji,desc,name_en,desc_en',
      downloadTpl: '📥 Download Template',
      cancel: 'Cancel',
      startImport: 'Start Import',
      importing: 'Importing...'
    },
    km: {
      title: '📥 នាំចូលម៉ឺនុយជាដុំ',
      desc: 'ជ្រើសឯកសារ CSV ដើម្បីនាំចូល. ទ្រង់ទ្រាយ៖ name,category,price,emoji,desc,name_en,desc_en',
      downloadTpl: '📥 ទាញយកគំរូ',
      cancel: 'បោះបង់',
      startImport: 'ចាប់ផ្តើមនាំចូល',
      importing: 'កំពុងនាំចូល...'
    }
  };
  const t = texts[lang] || texts.zh;
  
  document.querySelector('#importModal h3').textContent = t.title;
  document.querySelector('#importModal p').textContent = t.desc;
  document.querySelector('#importModal p a').textContent = t.downloadTpl;
  document.querySelector('#importModal button').textContent = t.cancel;
  document.getElementById('confirmImportBtn').textContent = t.startImport;
}

function closeImportModal() {
  document.getElementById('importModal').hidden = true;
  importItems = [];
}

// 简单 CSV 解析
function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const item = {};
    headers.forEach((h, idx) => { item[h] = values[idx] || ''; });
    result.push(item);
  }
  return result;
}

document.getElementById('importFile').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      importItems = parseCSV(ev.target.result);
      if (importItems.length === 0) {
        document.getElementById('importPreview').innerHTML = '<div style="color: #ff6b6b;">没有解析到有效数据</div>';
        document.getElementById('confirmImportBtn').disabled = true;
        return;
      }
      // 预览
      document.getElementById('importPreview').innerHTML = '<div style="color: #4caf50;">解析到 ' + importItems.length + ' 条数据：</div>' +
        importItems.slice(0, 10).map((item, i) => 
          '<div style="padding: 3px 0; border-bottom: 1px solid #eee;">' + (i+1) + '. ' + esc(item.name) + ' - $' + item.price + ' (' + item.category + ')</div>'
        ).join('') + (importItems.length > 10 ? '<div style="color: #888; padding: 5px 0;">... 共 ' + importItems.length + ' 条</div>' : '');
      document.getElementById('confirmImportBtn').disabled = false;
    } catch (err) {
      document.getElementById('importPreview').innerHTML = '<div style="color: #ff6b6b;">解析失败：' + err.message + '</div>';
      document.getElementById('confirmImportBtn').disabled = true;
    }
  };
  reader.readAsText(file, 'utf-8');
});

async function confirmImport() {
  if (importItems.length === 0) return;
  document.getElementById('confirmImportBtn').disabled = true;
  document.getElementById('confirmImportBtn').textContent = '导入中...';
  try {
    const result = await api('/admin/menu/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: importItems })
    });
    let html = '<div style="background: #e8f5e9; color: #2e7d32; padding: 10px; border-radius: 6px;">' +
      '✅ 成功导入 ' + result.success + ' 条';
    if (result.failed > 0) html += '，失败 ' + result.failed + ' 条';
    html += '</div>';
    if (result.errors && result.errors.length) {
      html += '<div style="margin-top: 5px; font-size: 12px; color: #c62828;">' + result.errors.slice(0, 5).join('<br>') + '</div>';
    }
    document.getElementById('importResult').innerHTML = html;
    await loadMenus();
  } catch (e) {
    document.getElementById('importResult').innerHTML = '<div style="background: #ffebee; color: #c62828; padding: 10px; border-radius: 6px;">❌ 导入失败：' + e.message + '</div>';
  } finally {
    document.getElementById('confirmImportBtn').disabled = false;
    document.getElementById('confirmImportBtn').textContent = '开始导入';
  }
}

})();

// ===== 批量导入（放在 IIFE 外面，避免 ctx 未加载时函数不定义）=====
let importItems = [];

function openImportModal() {
  document.getElementById('importModal').hidden = false;
  document.getElementById('importFile').value = '';
  document.getElementById('importPreview').innerHTML = '';
  document.getElementById('importResult').innerHTML = '';
  document.getElementById('confirmImportBtn').disabled = true;
  
  // 多语言
  const lang = SLF.i18n.lang || 'zh';
  const texts = {
    zh: {
      title: '📥 批量导入菜品',
      desc: '选择 CSV 文件导入菜品，格式：name,category,price,emoji,desc,name_en,desc_en',
      downloadTpl: '📥 下载模板',
      cancel: '取消',
      startImport: '开始导入',
      importing: '导入中...'
    },
    en: {
      title: '📥 Batch Import Menu',
      desc: 'Select CSV file to import. Format: name,category,price,emoji,desc,name_en,desc_en',
      downloadTpl: '📥 Download Template',
      cancel: 'Cancel',
      startImport: 'Start Import',
      importing: 'Importing...'
    },
    km: {
      title: '📥 នាំចូលម៉ឺនុយជាដុំ',
      desc: 'ជ្រើសឯកសារ CSV ដើម្បីនាំចូល. ទ្រង់ទ្រាយ៖ name,category,price,emoji,desc,name_en,desc_en',
      downloadTpl: '📥 ទាញយកគំរូ',
      cancel: 'បោះបង់',
      startImport: 'ចាប់ផ្តើមនាំចូល',
      importing: 'កំពុងនាំចូល...'
    }
  };
  const t = texts[lang] || texts.zh;
  
  document.querySelector('#importModal h3').textContent = t.title;
  document.querySelector('#importModal p').textContent = t.desc;
  document.querySelector('#importModal p a').textContent = t.downloadTpl;
  document.querySelector('#importModal button').textContent = t.cancel;
  document.getElementById('confirmImportBtn').textContent = t.startImport;
}

function closeImportModal() {
  document.getElementById('importModal').hidden = true;
  importItems = [];
}

// 简单 CSV 解析
function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const item = {};
    headers.forEach((h, idx) => { item[h] = values[idx] || ''; });
    result.push(item);
  }
  return result;
}

document.getElementById('importFile').addEventListener('change', function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    try {
      importItems = parseCSV(ev.target.result);
      if (importItems.length === 0) {
        document.getElementById('importPreview').innerHTML = '<div style="color: #ff6b6b;">没有解析到有效数据</div>';
        document.getElementById('confirmImportBtn').disabled = true;
        return;
      }
      // 预览
      document.getElementById('importPreview').innerHTML = '<div style="color: #4caf50;">解析到 ' + importItems.length + ' 条数据：</div>' +
        importItems.slice(0, 10).map((item, i) => 
          '<div style="padding: 3px 0; border-bottom: 1px solid #eee;">' + (i+1) + '. ' + item.name + ' - $' + item.price + ' (' + item.category + ')</div>'
        ).join('') + (importItems.length > 10 ? '<div style="color: #888; padding: 5px 0;">... 共 ' + importItems.length + ' 条</div>' : '');
      document.getElementById('confirmImportBtn').disabled = false;
    } catch (err) {
      document.getElementById('importPreview').innerHTML = '<div style="color: #ff6b6b;">解析失败：' + err.message + '</div>';
      document.getElementById('confirmImportBtn').disabled = true;
    }
  };
  reader.readAsText(file, 'utf-8');
});

async function confirmImport() {
  if (importItems.length === 0) return;
  document.getElementById('confirmImportBtn').disabled = true;
  document.getElementById('confirmImportBtn').textContent = '导入中...';
  try {
    const result = await window.SLF.api.post('/admin/menu/batch', { items: importItems });
    let html = '<div style="background: #e8f5e9; color: #2e7d32; padding: 10px; border-radius: 6px;">' +
      '✅ 成功导入 ' + result.success + ' 条';
    if (result.failed > 0) html += '，失败 ' + result.failed + ' 条';
    html += '</div>';
    if (result.errors && result.errors.length) {
      html += '<div style="margin-top: 5px; font-size: 12px; color: #c62828;">' + result.errors.slice(0, 5).join('<br>') + '</div>';
    }
    document.getElementById('importResult').innerHTML = html;
    await window.SLF.admin.loadMenus();
  } catch (e) {
    document.getElementById('importResult').innerHTML = '<div style="background: #ffebee; color: #c62828; padding: 10px; border-radius: 6px;">❌ 导入失败：' + e.message + '</div>';
  } finally {
    document.getElementById('confirmImportBtn').disabled = false;
    document.getElementById('confirmImportBtn').textContent = '开始导入';
  }
}

window.openImportModal = openImportModal;
window.closeImportModal = closeImportModal;
window.confirmImport = confirmImport;
