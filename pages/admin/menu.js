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
      // 副币统一由店铺级设置决定，不再读菜品级字段
      const _base = SLF.money.toBase(m.price, m.currency_code || 'USD');
      const _sec = SLF.money.secondaryCurrency;
      if (_sec && _sec.code) {
        const sec = SLF.money.secondary(_base, _sec.code);
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
    filterSelect.innerHTML = '<option value="all">' + tAdmin('menuAllCategoriesOption') + '</option>' +
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
  $('#menuEmoji').value = current.emoji || '';
  $('#menuDesc').value = current.desc || '';
  $('#menuDescEn').value = current.desc_en || '';
  $('#menuImageFile').value = '';
  const _vf = $('#menuVideoFile'); if (_vf) _vf.value = '';
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
          ['unit', 'menuUnit']
        ].forEach(([k, id]) => {
          const el = $('#' + id);
          form.append(k, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
        });
        const file = $('#menuImageFile').files[0];
        const videoFile = $('#menuVideoFile') && $('#menuVideoFile').files[0];
        if (videoFile) form.append('video', videoFile);
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
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
            form.set('image', blob, 'menu_' + Date.now() + '.jpg');
          } catch (imgErr) { console.warn('图片压缩失败:', imgErr); }
        }
        if (isEditing) {
          await SLF.api.put('/menu/' + editingMenuId, form);
        } else {
          await SLF.api.post('/menu', form);
        }
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

})();

// ===== 批量导入 =====
let importItems = [];

function openImportModal() {
  document.getElementById('importModal').classList.add('open');
  document.getElementById('importFile').value = '';
  document.getElementById('importPreview').innerHTML = '';
  document.getElementById('importResult').innerHTML = '';
  document.getElementById('confirmImportBtn').disabled = true;
  
  var lang = (window.SLF.i18n && SLF.i18n.lang) || 'zh';
  var texts = {
    zh: { title: '📥 批量导入菜品', desc: '选择 CSV 文件导入菜品，格式：name,category,price,emoji,desc,name_en,desc_en,image（image 填图片URL）', downloadTpl: '📥 下载模板', cancel: '取消', startImport: '开始导入', importing: '导入中...' },
    en: { title: '📥 Batch Import Menu', desc: 'Select CSV file to import. Format: name,category,price,emoji,desc,name_en,desc_en', downloadTpl: '📥 Download Template', cancel: 'Cancel', startImport: 'Start Import', importing: 'Importing...' },
    km: { title: '📥 នាំចូលម៉ឺនុយជាដុំ', desc: 'ជ្រើសឯកសារ CSV ដើម្បីនាំចូល', downloadTpl: '📥 ទាញយកគំរូ', cancel: 'បោះបង់', startImport: 'ចាប់ផ្តើមនាំចូល', importing: 'កំពុងនាំចូល...' },
    th: { title: '📥 นำเข้าเมนูจำนวนมาก', desc: 'เลือกไฟล์ CSV เพื่อนำเข้า', downloadTpl: '📥 ดาวน์โหลดเทมเพลต', cancel: 'ยกเลิก', startImport: 'เริ่มนำเข้า', importing: 'กำลังนำเข้า...' },
    vi: { title: '📥 Nhập khẩu hàng loạt món ăn', desc: 'Chọn tệp CSV để nhập khẩu', downloadTpl: '📥 Tải xuống mẫu', cancel: 'Hủy', startImport: 'Bắt đầu nhập', importing: 'Đang nhập...' }
  };
  var t = texts[lang] || texts.zh;
  
  document.querySelector('#importModal h2').textContent = t.title;
  document.querySelector('#importModal p').textContent = t.desc;
  document.querySelector('#importModal p a').textContent = t.downloadTpl;

  document.getElementById('confirmImportBtn').textContent = t.startImport;
}

function closeImportModal() {
  document.getElementById('importModal').classList.remove('open');
  importItems = [];
}

function parseCSV(text) {
  var lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(function(l) { return l.trim(); });
  if (lines.length < 2) return [];
  var headers = lines[0].split(',').map(function(h) { return h.trim(); });
  var result = [];
  for (var i = 1; i < lines.length; i++) {
    var values = lines[i].split(',').map(function(v) { return v.trim(); });
    var item = {};
    headers.forEach(function(h, idx) { item[h] = values[idx] || ''; });
    result.push(item);
  }
  return result;
}

document.getElementById('importFile').addEventListener('change', function(e) {
  var file = e.target.files[0];
  if (!file) return;
  if (/\.zip$/i.test(file.name)) {
    var preview = document.getElementById('importPreview');
    preview.innerHTML = '<div style="color:#4a9eff;">ZIP: ' + file.name + ' (' + (file.size/1024).toFixed(1) + ' KB)<br>点击"开始导入"解压并同步图片</div>';
    document.getElementById('confirmImportBtn').disabled = false;
    window._importZipFile = file;
    importItems = [];
    return;
  }
  window._importZipFile = null;
  var reader = new FileReader();
  reader.onload = function(ev) {
    try {
      importItems = parseCSV(ev.target.result);
      var preview = document.getElementById('importPreview');
      if (importItems.length === 0) {
        preview.innerHTML = '<div style="color: #ff6b6b;">没有解析到有效数据</div>';
        document.getElementById('confirmImportBtn').disabled = true;
        return;
      }
      preview.innerHTML = '<div style="color: #4caf50;">解析到 ' + importItems.length + ' 条数据：</div>' +
        importItems.slice(0, 10).map(function(item, i) { 
          return '<div style="padding: 3px 0; border-bottom: 1px solid #eee;">' + (i+1) + '. ' + item.name + ' - $' + item.price + ' (' + item.category + ')</div>';
        }).join('') + (importItems.length > 10 ? '<div style="color: #888; padding: 5px 0;">... 共 ' + importItems.length + ' 条</div>' : '');
      document.getElementById('confirmImportBtn').disabled = false;
    } catch (err) {
      document.getElementById('importPreview').innerHTML = '<div style="color: #ff6b6b;">解析失败：' + err.message + '</div>';
      document.getElementById('confirmImportBtn').disabled = true;
    }
  };
  reader.readAsText(file, 'utf-8');
});

async function confirmImport() {
  if (window._importZipFile) {
    const f = window._importZipFile;
    const btn = document.getElementById('confirmImportBtn');
    btn.disabled = true;
    btn.textContent = '解压导入中...';
    try {
      const fd = new FormData();
      fd.append('file', f);
      const data = await SLF.api.upload('/admin/menu/import-zip', fd);
      let html = '<div style="background:#e8f5e9;color:#2e7d32;padding:10px;border-radius:6px;">OK 成功导入 ' + data.success + ' 条';
      if (data.imagesImported) html += '，图片 ' + data.imagesImported + ' 张';
      if (data.createdCategories && data.createdCategories.length) html += '，新建分类 ' + data.createdCategories.length + ' 个';
      html += '</div>';
      if (data.failed > 0 && data.errors) html += '<div style="margin-top:5px;font-size:12px;color:#c62828;">' + data.errors.slice(0, 5).join('<br>') + '</div>';
      document.getElementById('importResult').innerHTML = html;
      window._importZipFile = null;
      setTimeout(function(){ location.reload(); }, 1500);
    } catch (e) {
      document.getElementById('importResult').innerHTML = '<div style="background:#ffebee;color:#c62828;padding:10px;border-radius:6px;">失败：' + e.message + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = '开始导入';
    }
    return;
  }
  if (importItems.length === 0) return;
  // 打开确认弹窗
  document.getElementById('confirmImportText').textContent = '确认导入 ' + importItems.length + ' 条菜品？重复的同名菜品将自动覆盖更新！';
  document.getElementById('confirmImportModal').classList.add('open');
  // 绑定确认按钮
  document.getElementById('confirmImportYesBtn').onclick = function() {
    closeConfirmImport();
    doImport();
  };
}

function closeConfirmImport() {
  document.getElementById('confirmImportModal').classList.remove('open');
}

async function doImport() {
  var btn = document.getElementById('confirmImportBtn');
  btn.disabled = true;
  btn.textContent = '导入中...';
  try {
    var result = await window.SLF.api.post('/menu/batch', { items: importItems });
    var createdInfo = '';
    if (result.createdCategories && result.createdCategories.length > 0) {
      createdInfo = '，新建分类 ' + result.createdCategories.length + ' 个：' + result.createdCategories.join('、');
    }
    var html = '<div style="background: #e8f5e9; color: #2e7d32; padding: 10px; border-radius: 6px;">' +
      '✅ 成功导入 ' + result.success + ' 条' + createdInfo;
    if (result.failed > 0) html += '，失败 ' + result.failed + ' 条';
    html += '</div>';
    if (result.errors && result.errors.length) {
      html += '<div style="margin-top: 5px; font-size: 12px; color: #c62828;">' + result.errors.slice(0, 5).join('<br>') + '</div>';
    }
    document.getElementById('importResult').innerHTML = html;
    setTimeout(() => location.reload(), 1500);
  } catch (e) {
    document.getElementById('importResult').innerHTML = '<div style="background: #ffebee; color: #c62828; padding: 10px; border-radius: 6px;">❌ 导入失败：' + e.message + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = '开始导入';
  }
}


async function exportMenuZip() {
  try {
    const storeId = SLF.store.rawGetSession('adminStoreId') || SLF.store.rawGet('storeId') || '1';
    const token = SLF.store.rawGetSession('adminToken') || '';
    SLF.ui.toast('📦 ' + (tAdmin('exporting') || '正在打包...'));
    const res = await fetch('/api/admin/menu/export-zip?store_id=' + storeId, { headers: { 'Authorization': 'Bearer ' + token, 'X-Store-Id': String(storeId) } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'menu-store' + storeId + '-' + new Date().toISOString().slice(0,10) + '.zip';
    a.click(); URL.revokeObjectURL(a.href);
    SLF.ui.toast('✅ ' + (tAdmin('exported') || '已导出'));
  } catch (e) { SLF.ui.toast('❌ ' + (tAdmin('exportFailed') || '导出失败') + ': ' + e.message); }
}
window.exportMenuZip = exportMenuZip;

window.openImportModal = openImportModal;
window.closeImportModal = closeImportModal;
window.confirmImport = confirmImport;
window.closeConfirmImport = closeConfirmImport;