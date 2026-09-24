/*
 * FoodFlow · admin 页面逻辑（由内联脚本抽出，onclick 函数挂 window）
 */
(function(){
'use strict';
        // 全局状态
        const $ = s => document.querySelector(s);
        let adminToken = SLF.store.rawGetSession('adminToken') || '';
        let adminId = parseInt(SLF.store.rawGetSession('adminId') || '0', 10);
        let adminIsPrimary = SLF.store.rawGetSession('adminIsPrimary') === '1';
        let adminPermissions = {};
        try { adminPermissions = JSON.parse(SLF.store.rawGetSession('adminPermissions') || '{}'); } catch (e) {}

        // 权限检查：默认有权限，只有明确为 0 才视为无权限
        function hasPermission(permKey) {
            // 未设置任何权限信息时（旧登录状态），默认显示，避免误隐藏
            if (SLF.store.rawGetSession('adminIsPrimary') === null && Object.keys(adminPermissions).length === 0) {
                return true;
            }
            if (adminIsPrimary) return true;
            // 权限字段未定义时视为有权限（兼容旧数据）
            if (adminPermissions[permKey] === undefined) return true;
            return !!adminPermissions[permKey];
        }

        function applyPermissions() {
            document.querySelectorAll('.nav-item[data-perm]').forEach(item => {
                const perm = item.dataset.perm;
                item.style.display = (perm && !hasPermission(perm)) ? 'none' : '';
            });
            document.querySelectorAll('.store-sub-btn[data-perm]').forEach(btn => {
                const perm = btn.dataset.perm;
                btn.style.display = (perm && !hasPermission(perm)) ? 'none' : '';
            });
            const addBtnMap = {
                openDishModalBtn: 'can_manage_menu',
                addTableBtn: 'can_manage_table',
                addCurrencyBtn: 'can_manage_currency',
                addPrinterBtn: 'can_manage_printer',
                addWaiterBtn: 'can_manage_waiter',
                addStoreBtn: 'can_manage_store'
            };
            for (const [btnId, perm] of Object.entries(addBtnMap)) {
                const btn = document.getElementById(btnId);
                if (btn) btn.style.display = hasPermission(perm) ? '' : 'none';
            }
            const adminManageCard = document.getElementById('adminManageCard');
            if (adminManageCard) adminManageCard.style.display = hasPermission('can_manage_admin') ? '' : 'none';
        }

        let menusCache = [];
        let tablesCache = [];
        let ordersCache = [];
        let printedOrders = new Set();
        let autoPrintPollTimer = null;
        let currenciesCache = [];
        let categoriesCache = [];
        let editingMenuId = null;
        let editingOrderId = null;
        let editingOrderStatus = 'pending';
        let editingTableId = null;
        let orderTableFilter = '';
        let adminLang = SLF.store.rawGet('adminLang') || 'zh';

        async function loadAdminLanguage(lang) {
            const globalDict = (typeof LANGUAGES !== 'undefined' && LANGUAGES[lang]) || {};
            SLF.i18n.dicts[lang] = { ...globalDict, _loaded: true };
            SLF.i18n.lang = lang;
            adminLang = lang;
            return true;
        }

        let dualCurrencyEnabled = false;
        let secondaryCurrencyCode = 'USD';
        let defaultCurrencyObj = null;

        const tAdmin = (k, params) => SLF.i18n.t(k, params);
        const L = tAdmin;

        function buildSessionLabels(orders) {
            const byTable = new Map();
            for (const o of orders) {
                if (!byTable.has(o.table)) byTable.set(o.table, []);
                byTable.get(o.table).push(o);
            }
            const labels = new Map();
            for (const [, tableOrders] of byTable) {
                const sorted = [...tableOrders].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
                const tokenToIndex = SLF.customerGroup.buildIndex(sorted);
                for (const o of sorted) {
                    if (o.sessionToken) {
                        labels.set(o.id, `${tAdmin('customer')}${tokenToIndex.get(o.customerToken)}`);
                    } else if (sorted.some(x => x.sessionToken)) {
                        labels.set(o.id, tAdmin('staffOrder'));
                    }
                }
            }
            return labels;
        }


        // ===== 共享工具（已移到 pages/admin/shared.js）=====


        // ===== 管理员管理 =====
        const ADMIN_PERMISSIONS = [
            { key: 'can_manage_menu', labelKey: 'permMenu', icon: '🍽️', group: 'permGroupOps' },
            { key: 'can_manage_table', labelKey: 'permTable', icon: '🪑', group: 'permGroupOps' },
            { key: 'can_manage_order', labelKey: 'permOrder', icon: '📋', group: 'permGroupOps' },
            { key: 'can_delete_order', labelKey: 'permDeleteOrder', icon: '🗑️', group: 'permGroupOps' },
            { key: 'can_edit_order', labelKey: 'permEditOrder', icon: '✏️', group: 'permGroupOps' },
            { key: 'can_manage_store', labelKey: 'permStore', icon: '🏪', group: 'permGroupBase' },
            { key: 'can_manage_waiter', labelKey: 'permWaiter', icon: '👥', group: 'permGroupBase' },
            { key: 'can_manage_currency', labelKey: 'permCurrency', icon: '💱', group: 'permGroupBase' },
            { key: 'can_manage_printer', labelKey: 'permPrinter', icon: '🖨️', group: 'permGroupBase' },
            { key: 'can_manage_cashier', labelKey: 'permCashier', icon: '💳', group: 'permGroupBase' },
            { key: 'can_manage_admin', labelKey: 'permAdmin', icon: '👤', group: 'permGroupSystem' },
            { key: 'can_view_logs', labelKey: 'permLogs', icon: '📝', group: 'permGroupSystem' }
        ];

        function renderAdminPermissions(containerId, permissions, disabled) {
            const container = document.getElementById(containerId);
            if (!container) return;
            const groups = {};
            ADMIN_PERMISSIONS.forEach(p => {
                if (!groups[p.group]) groups[p.group] = [];
                groups[p.group].push(p);
            });
            let html = '';
            for (const [groupKey, perms] of Object.entries(groups)) {
                html += `<div class="admin-perm-group">
                    <div class="admin-perm-group-title">${tAdmin(groupKey)}</div>
                    <div class="admin-perm-items">`;
                perms.forEach(p => {
                    const checked = permissions && permissions[p.key] ? 'checked' : '';
                    const dis = disabled ? 'disabled' : '';
                    html += `<label class="admin-perm-item ${disabled ? 'disabled' : ''}">
                        <span class="admin-perm-icon">${p.icon}</span>
                        <span class="admin-perm-label">${tAdmin(p.labelKey)}</span>
                        <label class="store-switch">
                            <input type="checkbox" class="admin-perm-checkbox" data-key="${p.key}" ${checked} ${dis}>
                            <span class="store-switch-slider"></span>
                        </label>
                    </label>`;
                });
                html += `</div></div>`;
            }
            container.innerHTML = html;
        }

        function collectAdminPermissions(containerId) {
            const container = document.getElementById(containerId);
            if (!container) return {};
            const perms = {};
            container.querySelectorAll('.admin-perm-checkbox').forEach(cb => {
                perms[cb.dataset.key] = cb.checked ? 1 : 0;
            });
            return perms;
        }

        function openAddAdminModal() {
            if (!hasPermission('can_manage_admin')) { SLF.ui.toast('❌ ' + tAdmin('noPermission')); return; }
            document.getElementById('addAdminUsername').value = '';
            document.getElementById('addAdminPassword').value = '';
            document.getElementById('addAdminDisplayName').value = '';
            const defaultPerms = {};
            ADMIN_PERMISSIONS.forEach(p => { defaultPerms[p.key] = p.key === 'can_manage_admin' ? 0 : 1; });
            renderAdminPermissions('addAdminPermissions', defaultPerms, false);
            document.getElementById('adminAddModal').classList.add('open');
        }
        function closeAddAdminModal() { document.getElementById('adminAddModal').classList.remove('open'); }

        // ===== 管理员管理（已移到 pages/admin/admin-mgr.js）=====


        // ===== 收银员管理 =====
        let editingCashierId = null;
        // ===== 收银员管理（已移到 pages/admin/cashier-mgr.js）=====


        function switchMenuTab(tab) {
            $('#menuTabDish').classList.toggle('active', tab === 'dish');
            $('#dishPanel').style.display = tab === 'dish' ? 'block' : 'none';
        }

        // ===== 操作日志（已移到 pages/admin/logs.js）=====


        // ===== 服务员管理（已移到 pages/admin/waiter.js）=====


        // ===== 店铺管理（已移到 pages/admin/store.js）=====


        // ===== 显示设置（已移到 pages/admin/settings.js）=====


        // ===== 操作函数 =====
        // ===== 菜品编辑（已移到 pages/admin/menu.js）=====


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
                                    const i = new Image();
                                    i.onload = () => res(i);
                                    i.onerror = rej;
                                    i.src = dataUrl;
                                });
                                const canvas = document.createElement('canvas');
                                const max = 800;
                                const scale = Math.min(1, max / Math.max(img.width, img.height));
                                canvas.width = Math.round(img.width * scale);
                                canvas.height = Math.round(img.height * scale);
                                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                                const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.8));
                                form.append('image', blob, 'menu_' + Date.now() + '.jpg');
                            } catch (e) {
                                console.warn('图片压缩失败，使用原图', e);
                                form.append('image', file);
                            }
                        }
                        await api(isEditing ? '/menu/' + editingMenuId : '/menu', { method: isEditing ? 'PUT' : 'POST', body: form });
                        closeDishModal();
                        await window.loadMenuCategories();
                        await window.loadMenus();
                        SLF.ui.toast('✅ ' + tAdmin('menuManage') + ' ' + (isEditing ? tAdmin('updated') : tAdmin('added')));
                    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
                };
            }
        });

        // (removeTable/editTable/openTableForm/closeTableForm 已移到 table.js)

        // ===== 桌台表单提交（已移到 table.js）=====


        function filterOrders() {
            orderTableFilter = $('#orderTableSearch').value.trim();
            window.loadOrders();
        }

        // ===== 订单操作（已移到 pages/admin/order.js）=====


        // ===== 订单编辑表单（已移到 pages/admin/order.js）=====


        document.addEventListener('DOMContentLoaded', function() {
            const orderSaveBtn = document.getElementById('orderSaveBtn');
            if (orderSaveBtn) {
                orderSaveBtn.onclick = async function() {
                    const rows = [...document.querySelectorAll('#orderItems .order-item-line')];
                    const items = [];
                    rows.forEach(row => {
                        const id = +row.querySelector('select').value;
                        const quantity = +row.querySelector('input').value;
                        const itemStatus = row.dataset.status === 'done' ? 'done' : 'pending';
                        if (id && quantity > 0) items.push({ id, quantity, itemStatus });
                    });
                    try {
                        const noteValue = $('#orderNoteField').value.trim().slice(0, 200);
                        const payload = editingOrderId ? { items, status: editingOrderStatus, note: noteValue } : { table: $('#orderTable').value, items, note: noteValue };
                        await api(editingOrderId ? '/orders/' + editingOrderId : '/orders', {
                            method: editingOrderId ? 'PUT' : 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        closeOrderForm();
                        await window.loadOrders();
                        SLF.ui.toast('✅ ' + tAdmin('orderManage') + ' ' + (editingOrderId ? tAdmin('updated') : tAdmin('added')));
                    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
                };
            }
            const addOrderItemBtn = document.getElementById('addOrderItemBtn');
            if (addOrderItemBtn) addOrderItemBtn.onclick = function() { addOrderItem(); };
        });

        // (editCurrency/saveCurrencyEdit/setDefaultCurrency/removeCurrency 已移到 currency.js)
        // ===== 货币表单提交（已移到 currency.js）=====


        // (updateWaiterPerm/deleteWaiter 已移到 waiter.js)
        document.addEventListener('DOMContentLoaded', function() {
            const addWaiterBtn = document.getElementById('addWaiterBtn');
            if (addWaiterBtn) {
                addWaiterBtn.onclick = async function() {
                    const username = $('#waiterUsernameInput').value.trim();
                    const password = $('#waiterPasswordInput').value;
                    const display_name = $('#waiterNameInput').value.trim();
                    const store_id = parseInt($('#waiterStoreSelect').value) || 1;
                    if (!username || !password || !display_name) { SLF.ui.toast(`❌ ${tAdmin('waiterInfoRequired')}`); return; }
                    try {
                        await api('/admin/waiters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { username, password, display_name, can_order: 1, can_mark_item: 1, can_complete_order: 1, store_id } });
                        $('#waiterUsernameInput').value = '';
                        $('#waiterPasswordInput').value = '';
                        $('#waiterNameInput').value = '';
                        window.loadWaiters();
                        SLF.ui.toast('✅ ' + tAdmin('added'));
                    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
                };
            }
        });

        // (deleteStore/copyStoreMenu 已移到 store.js)
        document.addEventListener('DOMContentLoaded', function() {
            const addStoreBtn = document.getElementById('addStoreBtn');
            if (addStoreBtn) {
                addStoreBtn.onclick = async function() {
                    const name = $('#storeNameInput').value.trim();
                    const code = $('#storeCodeInput').value.trim();
                    const address = $('#storeAddressInput').value.trim();
                    if (!name) { SLF.ui.toast(`❌ ${tAdmin('enterStoreName')}`); return; }
                    try {
                        await api('/admin/stores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { name, code, address } });
                        $('#storeNameInput').value = '';
                        $('#storeCodeInput').value = '';
                        $('#storeAddressInput').value = '';
                        window.loadStores();
                        SLF.ui.toast('✅ ' + tAdmin('added'));
                    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
                };
            }
            const passwordForm = document.getElementById('passwordForm');
            if (passwordForm) {
                passwordForm.onsubmit = async function(e) {
                    e.preventDefault();
                    try {
                        await api('/admin/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: {
                            oldPassword: $('#oldPassword').value,
                            newPassword: $('#newPassword').value
                        }});
                        e.target.reset();
                        SLF.ui.toast('✅ ' + tAdmin('passwordTitle') + ' ' + tAdmin('updated'));
                    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
                };
            }
        });

        // (showQr 已移到 table.js)

        document.addEventListener('DOMContentLoaded', function() {
            const saveDisplaySettingsBtn = document.getElementById('saveDisplaySettingsBtn');
            if (saveDisplaySettingsBtn) {
                saveDisplaySettingsBtn.onclick = async function() {
                    try {
                        await SLF.api.post('/admin/display-settings', {
                            enabled: document.getElementById('dualCurrencyEnabled').checked,
                            secondaryCurrencyCode: document.getElementById('dualCurrencySelect').value
                        });
                        SLF.ui.toast('✅ ' + tAdmin('displaySettingsSaved'));
                        await loadDisplaySettings();
                        await loadOrderPrefixes();
                        await window.loadMenus();
                    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
                };
            }
            const saveNotifySettingsBtn = document.getElementById('saveNotifySettingsBtn');
            if (saveNotifySettingsBtn) {
                saveNotifySettingsBtn.onclick = async function() {
                    try {
                        await SLF.api.post('/admin/notification-settings', { enabled: document.getElementById('newOrderSoundEnabled').checked });
                        SLF.ui.toast('✅ ' + tAdmin('notifySettingsSaved'));
                        await loadNotificationSettings();
                    } catch (e) { SLF.ui.toast('❌ ' + e.message); }
                };
            }
            const resetDataBtn = document.getElementById('resetDataBtn');
            if (resetDataBtn) {
                resetDataBtn.onclick = function() {
                    showPasswordModal(tAdmin('resetDataPasswordMsg'), function(password) {
                        showConfirm(tAdmin('resetDataConfirmMsg'), async function() {
                            try {
                                await SLF.api.post('/admin/reset-data', { password });
                                SLF.ui.toast('✅ ' + tAdmin('resetSuccess'));
                                await window.loadOrders();
                                await window.loadTables();
                                await loadLoginLogs();
                            } catch (e) { SLF.ui.toast('❌ ' + e.message); }
                        }, tAdmin('resetDataConfirmTitle'));
                    }, tAdmin('resetDataPasswordTitle'));
                };
            }
        });

        // ===== 服务员编辑功能（已移到 waiter.js）=====


        document.addEventListener('DOMContentLoaded', function() {
            const saveWaiterEditBtn = document.getElementById('saveWaiterEditBtn');
            if (saveWaiterEditBtn) {
                saveWaiterEditBtn.onclick = async function() {
                    const id = parseInt($('#editWaiterId').value);
                    const username = $('#editWaiterUsername').value.trim();
                    const display_name = $('#editWaiterDisplayName').value.trim();
                    const store_id = parseInt($('#editWaiterStore').value);
                    const password = $('#editWaiterPassword').value.trim();
                    const can_order = $('#editWaiterCanOrder').checked ? 1 : 0;
                    const can_mark_item = $('#editWaiterCanMarkItem').checked ? 1 : 0;
                    const can_complete_order = $('#editWaiterCanCompleteOrder').checked ? 1 : 0;
                    if (!username || !display_name) { SLF.ui.toast(`❌ ${tAdmin('usernameAndNameRequired')}`); return; }
                    try {
                        const payload = { username, display_name, store_id, can_order, can_mark_item, can_complete_order };
                        if (password) payload.password = password;
                        await api('/admin/waiters/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                        closeWaiterEdit();
                        await window.loadWaiters();
                        SLF.ui.toast(`✅ ${tAdmin('waiterUpdated')}`);
                    } catch (e) { SLF.ui.toast(`❌ ${tAdmin('updateFailed')}: ` + e.message); }
                };
            }
        });

        // ===== 店铺编辑功能（已移到 store.js）=====


        document.addEventListener('DOMContentLoaded', function() {
            const editStoreActive = document.getElementById('editStoreActive');
            if (editStoreActive) {
                editStoreActive.addEventListener('change', function() {
                    const statusText = this.checked ? tAdmin('storeActive') : tAdmin('storeDisabled');
                    document.getElementById('storeEditStatusText').textContent = statusText;
                });
            }
            const saveStoreEditBtn = document.getElementById('saveStoreEditBtn');
            if (saveStoreEditBtn) {
                saveStoreEditBtn.onclick = async function() {
                    const id = parseInt($('#editStoreId').value);
                    const name = $('#editStoreName').value.trim();
                    const code = $('#editStoreCode').value.trim();
                    const address = $('#editStoreAddress').value.trim();
                    const active = $('#editStoreActive').checked ? 1 : 0;
                    const qrLanguages = Array.from(document.querySelectorAll('#qrLangSelector input[type="checkbox"]:checked')).map(cb => cb.value).join(',');
                    if (!name) { SLF.ui.toast(`❌ ${tAdmin('storeNameRequired')}`); return; }
                    try {
                        await api('/admin/stores/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: { name, code, address, active, qr_languages: qrLanguages } });
                        closeStoreEdit();
                        await window.loadStores();
                        SLF.ui.toast(`✅ ${tAdmin('storeUpdated')}`);
                    } catch (e) { SLF.ui.toast(`❌ ${tAdmin('updateFailed')}: ` + e.message); }
                };
            }
            document.querySelectorAll('.edit-modal').forEach(modal => {
                modal.addEventListener('click', function(e) {
                    if (e.target === this) this.classList.remove('open');
                });
            });
        });

        function updateOrderSummary() {
            const pending = ordersCache.filter(o => o.status === 'pending');
            const done = ordersCache.filter(o => o.status === 'done');
            const pendingAmount = pending.reduce((s, o) => s + Number(o.total || 0), 0);
            const doneAmount = done.reduce((s, o) => s + Number(o.total || 0), 0);
            $('#pendingOrderCount').textContent = pending.length;
            $('#pendingOrderAmount').textContent = SLF.money.primary(pendingAmount);
            $('#doneOrderCount').textContent = done.length;
            $('#doneOrderAmount').textContent = SLF.money.primary(doneAmount);
        }

        function getCurrentModule() {
            const activeNav = document.querySelector('.nav-item.active');
            return activeNav ? activeNav.dataset.module : 'menu';
        }

        function switchAdminModule(module) {
            document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.module === module));
            document.querySelectorAll('.module-panel').forEach(p => p.classList.toggle('active', p.id === 'module-' + module));
            if (module === 'orders') window.loadOrders();
            else if (module === 'tables') window.loadTables();
            else if (module === 'menu') window.loadMenus();
            else if (module === 'currencies') window.loadCurrencies();
            else if (module === 'logs') loadLoginLogs();
            else if (module === 'waiters') window.loadWaiters();
            else if (module === 'stores') window.loadStores();
            else if (module === 'reservations') loadReservations();
            else if (module === 'calls') window.loadWaiterCalls();
            else if (module === 'printers') window.loadPrinters();
            else if (module === 'reports') { $('#reportDate').value = new Date().toISOString().slice(0, 10); window.loadDailyReport(); loadReportSummary(); }
            else if (module === 'admins') window.loadAdmins();
            else if (module === 'cashiers') window.loadCashiers();
            applyPermissions();
        }

        function toggleSidebar() {
            const sidebar = document.getElementById('adminSidebar');
            const overlay = document.getElementById('sidebarOverlay');
            sidebar.classList.toggle('open');
            overlay.classList.toggle('show');
            document.body.style.overflow = sidebar.classList.contains('open') ? 'hidden' : '';
        }
        function closeSidebar() {
            const sidebar = document.getElementById('adminSidebar');
            const overlay = document.getElementById('sidebarOverlay');
            sidebar.classList.remove('open');
            overlay.classList.remove('show');
            document.body.style.overflow = '';
        }

        // 汉堡按钮拖动
        (function() {
            const btn = document.getElementById('hamburgerBtn');
            if (!btn) return;
            let isDragging = false;
            let startX, startY, startLeft, startTop;
            let hasMoved = false;
            function getPos(e) {
                if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
                return { x: e.clientX, y: e.clientY };
            }
            function onStart(e) {
                if (window.innerWidth > 1024) return;
                isDragging = true;
                hasMoved = false;
                const pos = getPos(e);
                startX = pos.x; startY = pos.y;
                const rect = btn.getBoundingClientRect();
                startLeft = rect.left; startTop = rect.top;
                btn.classList.add('dragging');
                btn.style.transition = 'none';
            }
            function onMove(e) {
                if (!isDragging) return;
                const pos = getPos(e);
                const dx = pos.x - startX, dy = pos.y - startY;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) { hasMoved = true; e.preventDefault(); }
                let newLeft = Math.max(0, Math.min(window.innerWidth - btn.offsetWidth, startLeft + dx));
                let newTop = Math.max(0, Math.min(window.innerHeight - btn.offsetHeight, startTop + dy));
                btn.style.left = newLeft + 'px';
                btn.style.top = newTop + 'px';
                e.preventDefault();
            }
            function onEnd() {
                if (!isDragging) return;
                isDragging = false;
                btn.classList.remove('dragging');
                btn.style.transition = '';
                if (hasMoved) {
                    const rect = btn.getBoundingClientRect();
                    const centerX = rect.left + rect.width / 2;
                    if (centerX < window.innerWidth / 2) btn.style.left = '8px';
                    else btn.style.left = (window.innerWidth - btn.offsetWidth - 8) + 'px';
                    if (rect.top < 60) btn.style.top = '8px';
                    else if (rect.bottom > window.innerHeight - 60) btn.style.top = (window.innerHeight - btn.offsetHeight - 8) + 'px';
                } else {
                    toggleSidebar();
                }
            }
            btn.addEventListener('mousedown', onStart);
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
            btn.addEventListener('touchstart', onStart, { passive: false });
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        })();

        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.addEventListener('click', function() {
                const module = this.dataset.module;
                switchAdminModule(module);
                if (window.innerWidth <= 1024) closeSidebar();
            });
        });

        async function refresh() {
            try {
                await window.window.loadCurrencies();
                await window.loadMenuCategories();
                await window.loadStores();
                await loadDisplaySettings();
                await loadOrderPrefixes();
                await loadNotificationSettings();
                const loadTasks = [window.loadMenus(), window.loadTables(), window.loadOrders(), loadLoginLogs()];
                if (hasPermission('can_manage_admin')) loadTasks.push(window.loadAdmins());
                if (hasPermission('can_view_logs')) loadTasks.push(loadAuditLogs());
                await Promise.all(loadTasks);
                const currentModule = getCurrentModule();
                if (currentModule) switchAdminModule(currentModule);
            } catch (e) {
                SLF.ui.toast('❌ ' + e.message);
                throw e;
            }
        }

        function applyAdminLanguage() {
            document.title = tAdmin('headerTitle');
            $('#adminHeaderTitle').textContent = tAdmin('headerTitle');
            $('#adminLang').value = adminLang;
            const dishText = $('#menuTabDishText'); if (dishText) dishText.textContent = tAdmin('dishManagement');
            const loginLogText = $('#logTabLoginText'); if (loginLogText) loginLogText.textContent = tAdmin('loginLogs');
            const auditLogText = $('#logTabAuditText'); if (auditLogText) auditLogText.textContent = tAdmin('auditLogs');
            const categoryBtnText = $('#categoryBtnText'); if (categoryBtnText) categoryBtnText.textContent = tAdmin('menuCategory');
            $('#logoutBtn').textContent = tAdmin('logout');
            $('#confirmCancelBtn').textContent = L('cancel') || '取消';
            // 服务员编辑模态框翻译
            $('#waiterEditUsernameLabel').textContent = tAdmin('waiterUsername');
            $('#waiterEditPasswordLabel').textContent = tAdmin('waiterPassword') + '（留空不修改）';
            $('#waiterEditDisplayNameLabel').textContent = tAdmin('waiterDisplayName');
            $('#waiterEditStoreLabel').textContent = tAdmin('waiterStore');
            $('#waiterEditPermissionLabel').textContent = tAdmin('waiterPermission');
            $('#permOrderLabel').textContent = tAdmin('permOrder');
            $('#permOrderDesc').textContent = tAdmin('permOrderDesc');
            $('#permMarkItemLabel').textContent = tAdmin('permMarkItem');
            $('#permMarkItemDesc').textContent = tAdmin('permMarkItemDesc');
            $('#permCompleteLabel').textContent = tAdmin('permCompleteOrder');
            $('#permCompleteDesc').textContent = tAdmin('permCompleteDesc');
            $('#editWaiterUsername').placeholder = tAdmin('waiterUsernamePlaceholder');
            $('#editWaiterPassword').placeholder = tAdmin('waiterPasswordPlaceholder');
            $('#editWaiterDisplayName').placeholder = tAdmin('waiterNamePlaceholder');
            $('#waiterEditCancelBtn').textContent = L('cancel') || '取消';
            $('#saveWaiterEditBtn').textContent = L('save') || '保存';
            // 店铺编辑模态框翻译
            $('#storeEditNameLabel').textContent = tAdmin('storeName');
            $('#storeEditCodeLabel').textContent = tAdmin('storeCode');
            $('#storeEditAddressLabel').textContent = tAdmin('storeAddress');
            $('#storeEditQrLangLabel').textContent = tAdmin('qrDisplayLanguages');
            $('#storeEditStatusLabel').textContent = tAdmin('storeStatus');
            $('#editStoreName').placeholder = tAdmin('storeNamePlaceholder');
            $('#editStoreCode').placeholder = tAdmin('storeCodePlaceholder');
            $('#editStoreAddress').placeholder = tAdmin('storeAddressPlaceholder');
            $('#storeEditCancelBtn').textContent = L('cancel') || '取消';
            $('#saveStoreEditBtn').textContent = L('save') || '保存';
            const editStoreActive = document.getElementById('editStoreActive');
            if (editStoreActive) {
                const statusText = editStoreActive.checked ? tAdmin('storeActive') : tAdmin('storeDisabled');
                $('#storeEditStatusText').textContent = statusText;
            }
            $('#confirmOkBtn').textContent = L('confirm') || '确定';
            $('#confirmTitle').textContent = L('confirmTitle') || '确认操作';
            $('#passwordModalTitle').textContent = tAdmin('passwordModalTitle') || '请输入密码';
            $('#passwordModalMessage').textContent = tAdmin('passwordModalMessage') || '请输入管理员密码以确认操作';
            $('#passwordModalInput').placeholder = tAdmin('passwordModalPlaceholder') || '请输入密码';
            $('#passwordCancelBtn').textContent = L('cancel') || '取消';
            $('#passwordOkBtn').textContent = L('confirm') || '确定';
            $('#editAdminTitle').textContent = '👤 ' + tAdmin('editAdminTitle');
            $('#editAdminUsernameLabel').textContent = tAdmin('editAdminUsernameLabel');
            $('#editAdminDisplayNameLabel').textContent = tAdmin('editAdminDisplayNameLabel');
            $('#editAdminDisplayName').placeholder = tAdmin('editAdminDisplayNamePlaceholder');
            $('#editAdminPasswordLabel').textContent = tAdmin('editAdminPasswordLabel');
            $('#editAdminPassword').placeholder = tAdmin('editAdminPasswordPlaceholder');
            $('#editAdminStatusLabel').textContent = tAdmin('editAdminStatusLabel');
            $('#editAdminActiveTitle').textContent = tAdmin('editAdminActiveTitle');
            $('#editAdminActiveDesc').textContent = tAdmin('editAdminActiveDesc');
            $('#editAdminPermNotice').textContent = tAdmin('editAdminPermNotice');
            $('#editAdminCancelBtn').textContent = L('cancel') || '取消';
            $('#saveAdminEditBtn').textContent = L('save') || '保存';
            $('#adminInfoTitle').textContent = tAdmin('adminInfoTitle');
            $('#adminInfoUsernameLabel').textContent = tAdmin('adminInfoUsername');
            $('#adminInfoMerchantLabel').textContent = tAdmin('adminInfoMerchant');
            $('#adminInfoCodeLabel').textContent = tAdmin('adminInfoCode') || '商户编码';
            $('#adminInfoStoreCountLabel').textContent = tAdmin('adminInfoStoreCount');
            $('#adminInfoContactLabel').textContent = tAdmin('adminInfoContact');
            $('#adminInfoPhoneLabel').textContent = tAdmin('adminInfoPhone');
            $('#adminInfoStatusLabel').textContent = tAdmin('adminInfoStatus');
            $('#adminInfoCreatedLabel').textContent = tAdmin('adminInfoCreated');
            $('#adminInfoLogoutBtn').textContent = tAdmin('logout');
            $('#todayRevenueLabel').textContent = tAdmin('todayRevenue');
            $('#monthRevenueLabel').textContent = tAdmin('monthRevenue');
            $('#hotDishesTitle').textContent = tAdmin('hotDishesTitle');
            document.querySelectorAll('[data-i18n-nav]').forEach(el => {
                const map = {
                    menu: L('menuManage'), tables: L('tablesManage'), orders: L('orderManage'),
                    currencies: tAdmin('currencyManageTitle'), reservations: tAdmin('reservationManage'),
                    calls: tAdmin('callWaiterManage') || '顾客消息', printers: tAdmin('printerManage'),
                    reports: tAdmin('reportManage'), logs: tAdmin('logsTitle'),
                    waiters: tAdmin('waitersManage'), stores: tAdmin('storesManage'),
                    storeSettings: tAdmin('storeSettingsNav'), systemSettings: tAdmin('systemSettings')
                };
                el.textContent = map[el.dataset.i18nNav] || el.textContent;
            });
            $('#menuFormTitle').textContent = tAdmin('menuManage');
            $('#openDishModalBtn').textContent = tAdmin('addDish');
            const sortSelect = $('#menuSortBy');
            if (sortSelect) {
                const currentValue = sortSelect.value;
                sortSelect.innerHTML = `
                    <option value="default">🔄 ${tAdmin('defaultSort')}</option>
                    <option value="name_asc">🔤 ${tAdmin('nameAsc')}</option>
                    <option value="name_desc">🔤 ${tAdmin('nameDesc')}</option>
                    <option value="price_asc">💰 ${tAdmin('priceAsc')}</option>
                    <option value="price_desc">💰 ${tAdmin('priceDesc')}</option>
                `;
                sortSelect.value = currentValue;
            }
            $('#dishModalTitle').textContent = editingMenuId ? tAdmin('menuManage') + ' #' + editingMenuId : tAdmin('addDish');
            $('#categoryModalTitle').textContent = tAdmin('dishCategoryManage');
            $('#newCategoryName').placeholder = tAdmin('newCategory');
            $('#addCategoryBtn').textContent = tAdmin('addCategory');
            $('#closeCategoryBtn').textContent = tAdmin('close');
            $('#menuName').placeholder = tAdmin('dishName');
            $('#menuNameEn').placeholder = tAdmin('nameEn');
            $('#menuPrice').placeholder = tAdmin('price');
            $('#menuUnit').placeholder = tAdmin('unit');
            $('#menuEmoji').placeholder = tAdmin('icon');
            $('#menuDesc').placeholder = tAdmin('desc');
            $('#menuDescEn').placeholder = tAdmin('descEn');
            $('#currencyDualLabel').textContent = tAdmin('dualCurrency');
            $('#menuSecondaryCurrencyLabel').textContent = tAdmin('secondaryCurrency');
            $('#menuSaveButton').textContent = editingMenuId ? L('save') : tAdmin('addDish');
            $('#menuCancelButton').textContent = tAdmin('cancelEdit');
            window.populateMenuCategorySelect();
            $('#tablePanelTitle').textContent = tAdmin('tableManageTitle');
            $('#tableName').placeholder = tAdmin('tableName');
            $('#addTableBtn').textContent = tAdmin('addTable');
            $('#orderPanelTitle').textContent = tAdmin('orderManage');
            $('#openOrderBtn').textContent = tAdmin('addOrder');
            $('#pendingLabel').textContent = tAdmin('pendingOrders');
            $('#doneLabel').textContent = tAdmin('completedOrders');
            $('#currencyPanelTitle').textContent = tAdmin('currencyManageTitle');
            $('#currencyCode').placeholder = tAdmin('currencyCode');
            $('#currencySymbol').placeholder = tAdmin('currencySymbol');
            $('#currencyName').placeholder = tAdmin('currencyName');
            $('#currencyRate').placeholder = tAdmin('currencyRateLabel');
            $('#addCurrencyBtn').textContent = tAdmin('addCurrency');
            $('#currencyCodeLabel').textContent = tAdmin('currencyCodeLabel');
            $('#currencySymbolLabel').textContent = tAdmin('currencySymbolLabel');
            $('#currencyNameLabel').textContent = tAdmin('currencyName');
            $('#currencyRateLabel').textContent = tAdmin('currencyRateLabel');
            $('#logsPanelTitle').textContent = tAdmin('logsTitle');
            $('#waitersPanelTitle').textContent = tAdmin('waitersManage');
            $('#storesPanelTitle').textContent = tAdmin('storesManage');
            $('#storeNameInput').placeholder = tAdmin('storeName');
            $('#storeCodeInput').placeholder = tAdmin('storeCode');
            $('#storeAddressInput').placeholder = tAdmin('storeAddress');
            $('#addStoreBtn').textContent = tAdmin('addStore');
            $('#storeNameLabel').textContent = tAdmin('storeName');
            $('#storeCodeLabel').textContent = tAdmin('storeCode');
            $('#storeAddressLabel').textContent = tAdmin('storeAddress');
            $('#waiterUsernameInput').placeholder = tAdmin('waiterUsername');
            $('#waiterPasswordInput').placeholder = tAdmin('waiterPassword');
            $('#waiterNameInput').placeholder = tAdmin('waiterDisplayName');
            $('#addWaiterBtn').textContent = tAdmin('addWaiter');
            $('#waiterUsernameLabel').textContent = tAdmin('waiterUsername');
            $('#waiterPasswordLabel').textContent = tAdmin('waiterPassword');
            $('#waiterNameLabel').textContent = tAdmin('waiterDisplayName');
            $('#waiterStoreLabel').textContent = tAdmin('waiterStore');
            $('#passwordPanelTitle').textContent = tAdmin('systemSettings');
            $('#changePasswordCardTitle').textContent = '🔐 ' + tAdmin('changePassword');
            $('#newPasswordLabel').textContent = tAdmin('newPasswordShort');
            $('#oldPassword').placeholder = tAdmin('oldPassword');
            $('#newPassword').placeholder = tAdmin('newPassword');
            $('#changePasswordBtn').textContent = tAdmin('changePassword');
            $('#notifyPanelTitle').textContent = tAdmin('notifyTitle');
            $('#newOrderSoundLabel').textContent = tAdmin('newOrderSoundLabel');
            $('#saveNotifySettingsBtn').textContent = tAdmin('saveNotifySettings');
            $('#resetDataCardTitle').textContent = tAdmin('resetDataCardTitle');
            $('#resetDataDesc').textContent = tAdmin('resetDataDesc');
            $('#resetDataBtn').textContent = tAdmin('resetDataBtn');
            $('#orderTableLabel').textContent = tAdmin('tableField');
            $('#orderDishListLabel').textContent = tAdmin('dishList');
            $('#addOrderItemBtn').textContent = tAdmin('addDishLine');
            $('#orderTotalLabel').textContent = tAdmin('total');
            $('#orderNoteFieldLabel').textContent = L('orderNoteDisplay') || '备注';
            $('#orderNoteField').placeholder = L('orderNotePlaceholder') || '';
            $('#orderCancelBtn').textContent = L('cancel');
            $('#orderSaveBtn').textContent = tAdmin('saveOrder');
            $('#tableNameLabel').textContent = tAdmin('tableNameLabel');
            $('#tableStatusLabel').textContent = tAdmin('statusLabel');
            $('#tableCancelBtn').textContent = L('cancel');
            $('#tableSaveBtn').textContent = tAdmin('save');
            const tableStatusOptions = $('#editTableStatus').options;
            tableStatusOptions[0].text = L('available');
            tableStatusOptions[1].text = L('occupied');
            tableStatusOptions[2].text = L('reserved');
            $('#currencyEditTitle').textContent = tAdmin('editCurrency');
            $('#currencyEditCodeLabel').textContent = tAdmin('currencyCodeLabel');
            $('#currencyEditNameLabel').textContent = tAdmin('currencyName');
            $('#currencyEditSymbolLabel').textContent = tAdmin('currencySymbolLabel');
            $('#currencyEditRateLabel').textContent = tAdmin('currencyRateLabel');
            $('#currencyCancelBtn').textContent = L('cancel');
            $('#currencySaveBtn').textContent = L('save');
            $('#saveDisplaySettingsBtn').textContent = tAdmin('saveDisplaySettings');
            $('#addAdminModalTitle').textContent = tAdmin('addAdminModalTitle');
            $('#addAdminUsernameLabel').textContent = tAdmin('addAdminUsernameLabel');
            $('#addAdminPasswordLabel').textContent = tAdmin('addAdminPasswordLabel');
            $('#addAdminDisplayNameLabel').textContent = tAdmin('addAdminDisplayNameLabel');
            $('#addAdminPermissionsLabel').textContent = tAdmin('addAdminPermissionsLabel');
            $('#editAdminPermissionsLabel').textContent = tAdmin('editAdminPermissionsLabel');
            $('#reservationsPanelTitle').textContent = '📅 ' + tAdmin('reservationManage');
            $('#callsPanelTitle').textContent = '🔔 ' + tAdmin('callWaiterManage');
            $('#refreshCallsBtn').textContent = tAdmin('refreshCalls');
            $('#printersPanelTitle').textContent = '🖨️ ' + tAdmin('printerManage');
            $('#printerNameLabel').textContent = tAdmin('printerName');
            $('#printerTypeLabel').textContent = tAdmin('connectionType');
            $('#printerIpLabel').textContent = tAdmin('ipAddress');
            $('#printerPortLabel').textContent = tAdmin('port');
            $('#printerWidthLabel').textContent = tAdmin('paperWidth');
            $('#printerBrandLabel').textContent = tAdmin('brand');
            $('#printerName').placeholder = tAdmin('printerNamePlaceholder');
            $('#printerIp').placeholder = tAdmin('ipPlaceholder');
            $('#printerDefaultLabel').textContent = tAdmin('setAsDefault');
            $('#autoPrintTitle').textContent = tAdmin('autoPrintTitle') || '自动打印小票';
            $('#autoPrintDesc').textContent = tAdmin('autoPrintDesc') || '开启后，新订单创建时自动打印小票到默认打印机';
            $('#addPrinterBtn').textContent = tAdmin('addPrinter');
            const printerTypeOptions = $('#printerType').options;
            printerTypeOptions[0].text = tAdmin('networkPrinter');
            printerTypeOptions[1].text = tAdmin('usbPrinter');
            printerTypeOptions[2].text = tAdmin('bluetoothPrinter');
            const printerWidthOptions = $('#printerWidth').options;
            printerWidthOptions[0].text = tAdmin('paper58mm');
            printerWidthOptions[1].text = tAdmin('paper80mm');
            const printerBrandOptions = $('#printerBrand').options;
            printerBrandOptions[0].text = tAdmin('genericEscPos');
            printerBrandOptions[1].text = tAdmin('epson');
            printerBrandOptions[2].text = tAdmin('star');
            printerBrandOptions[3].text = tAdmin('bixolon');
            printerBrandOptions[4].text = tAdmin('jiabo');
            printerBrandOptions[5].text = tAdmin('xprinter');
            printerBrandOptions[6].text = tAdmin('rongta');
            printerBrandOptions[7].text = tAdmin('hoin');
            $('#reportsPanelTitle').textContent = '📊 ' + tAdmin('reportManage');
            $('#reportDateLabel').textContent = tAdmin('date') + ':';
            $('#queryReportBtn').textContent = tAdmin('query');
            $('#exportOrdersBtn').textContent = tAdmin('exportOrdersCsv');
            $('#exportSalesBtn').textContent = tAdmin('exportSalesCsv');
            $('#exportMenuBtn').textContent = tAdmin('exportMenuCsv');
            $('#adminsPanelTitle').textContent = '👤 ' + tAdmin('adminManageTitle');
            $('#addAdminBtnText').textContent = tAdmin('addAdminBtn');
            $('#cashiersPanelTitle').textContent = '💰 ' + tAdmin('cashierManage');
            $('#addCashierBtnText').textContent = tAdmin('addCashier');
            // 收银员编辑弹窗
            const _cu = $('#cashierUsernameLabel'); if (_cu) _cu.textContent = tAdmin('cashierUsername');
            const _cn = $('#cashierNameLabel'); if (_cn) _cn.textContent = tAdmin('cashierDisplayName');
            const _ca = $('#cashierActiveLabel'); if (_ca) _ca.textContent = tAdmin('accountActive');
            const _cp = $('#cashierPermTitle'); if (_cp) _cp.textContent = tAdmin('permissionConfig');
            const _cud = $('#cashierUsername'); if (_cud) _cud.placeholder = tAdmin('cashierUsernamePlaceholder');
            const _cnd = $('#cashierName'); if (_cnd) _cnd.placeholder = tAdmin('cashierDisplayNamePlaceholder');
            const _cpl = $('#cashierPasswordLabel'); if (_cpl) _cpl.textContent = tAdmin('passwordEditHint');
            const _cpp = $('#cashierPassword'); if (_cpp) _cpp.placeholder = tAdmin('leaveBlankToKeep');
            const _cas = $('#cashierActiveSub'); if (_cas) _cas.textContent = tAdmin('activeDesc');
            const _css = $('#cashierCanSettleSub'); if (_css) _css.textContent = tAdmin('canSettleDesc');
            const _ccs = $('#cashierCanCancelSub'); if (_ccs) _ccs.textContent = tAdmin('canCancelDesc');
            const _crs = $('#cashierCanRefundSub'); if (_crs) _crs.textContent = tAdmin('canRefundDesc');
            const _cvs = $('#cashierCanViewReportSub'); if (_cvs) _cvs.textContent = tAdmin('canViewReportDesc');
            const _csl = $('#cashierCanSettleLabel'); if (_csl) _csl.textContent = tAdmin('settleOrder');
            const _ccl = $('#cashierCanCancelLabel'); if (_ccl) _ccl.textContent = tAdmin('cancelOrder');
            const _crl = $('#cashierCanRefundLabel'); if (_crl) _crl.textContent = tAdmin('refund');
            const _cvl = $('#cashierCanViewReportLabel'); if (_cvl) _cvl.textContent = tAdmin('viewReport');
            $('#adminManageCardTitle').textContent = '👤 ' + tAdmin('adminManageTitle');
            $('#adminManageDesc').textContent = tAdmin('adminManageDesc');
            $('#enterAdminManageBtn').textContent = tAdmin('enterAdminManage');
            $('#cashierManageCardTitle').textContent = '💰 ' + tAdmin('cashierManage');
            $('#cashierManageDesc').textContent = tAdmin('cashierManageDesc');
            $('#enterCashierManageBtn').textContent = tAdmin('enterCashierManage');
            $('#orderPrefixTitle').textContent = '🔢 ' + tAdmin('orderPrefixTitle');
            $('#orderPrefixDesc').textContent = tAdmin('orderPrefixDesc');
            $('#prefixNormalLabel').textContent = tAdmin('prefixNormalLabel');
            $('#prefixRefundLabel').textContent = tAdmin('prefixRefundLabel');
            $('#prefixDiscountLabel').textContent = tAdmin('prefixDiscountLabel');
            $('#prefixVipLabel').textContent = tAdmin('prefixVipLabel');
            $('#savePrefixBtn').textContent = tAdmin('savePrefixBtn');
        }

        document.addEventListener('DOMContentLoaded', function() {
            $('#adminLang').onchange = async function() {
                adminLang = this.value;
                SLF.store.rawSet('adminLang', adminLang);
                await loadAdminLanguage(adminLang);
                SLF.i18n.lang = adminLang;
                applyAdminLanguage();
                if (typeof loadAdminInfo === 'function') loadAdminInfo();
                const currentModule = getCurrentModule();
                if (currentModule) switchAdminModule(currentModule);
                const auditLogsPanel = document.getElementById('auditLogsPanel');
                if (auditLogsPanel && auditLogsPanel.style.display !== 'none') loadAuditLogs();
            };
            $('#adminStoreSelect').onchange = function() {
                SLF.store.rawSetSession('adminStoreId', this.value);
                window.updateSidebarStore();
                refresh();
            };
        });

        // 空闲超时（统一 SLF.idle）
        let adminIdleTimeoutMin = 30;
        function adminIdleLogout() {
            adminToken = '';
            SLF.store.rawRemoveSession('adminToken');
            window.location.href = '/login';
        }
        SLF.idle.start({ timeoutMin: adminIdleTimeoutMin, onTimeout: adminIdleLogout });

        // 确认弹窗
        let confirmCallback = null;
        let confirmCancelCallback = null;
        function showConfirm(message, callback, title, cancelCallback) {
            document.getElementById('confirmTitle').textContent = title || tAdmin('confirmTitle') || '确认操作';
            document.getElementById('confirmMessage').textContent = message;
            confirmCallback = callback;
            confirmCancelCallback = cancelCallback || null;
            document.getElementById('confirmModal').classList.add('open');
        }
        function hideConfirm() {
            document.getElementById('confirmModal').classList.remove('open');
            if (confirmCancelCallback) {
                const cb = confirmCancelCallback;
                confirmCallback = null;
                confirmCancelCallback = null;
                cb();
            } else {
                confirmCallback = null;
            }
        }
        function executeConfirm() {
            if (confirmCallback) confirmCallback();
            hideConfirm();
        }

        // 密码输入弹窗
        let passwordCallback = null;
        function showPasswordModal(message, callback, title) {
            document.getElementById('passwordModalTitle').textContent = title || tAdmin('passwordModalTitle') || '请输入密码';
            document.getElementById('passwordModalMessage').textContent = message || tAdmin('passwordModalMessage') || '请输入管理员密码以确认操作';
            document.getElementById('passwordModalInput').placeholder = tAdmin('passwordModalPlaceholder') || '请输入密码';
            document.getElementById('passwordModalInput').value = '';
            passwordCallback = callback;
            document.getElementById('passwordModal').classList.add('open');
            setTimeout(() => document.getElementById('passwordModalInput').focus(), 100);
        }
        function hidePasswordModal() {
            document.getElementById('passwordModal').classList.remove('open');
            passwordCallback = null;
        }
        function executePasswordModal() {
            const password = document.getElementById('passwordModalInput').value;
            if (!password) { SLF.ui.toast('❌ ' + (tAdmin('passwordModalPlaceholder') || '请输入密码')); return; }
            if (passwordCallback) passwordCallback(password);
            hidePasswordModal();
        }

        document.addEventListener('DOMContentLoaded', function() {
            const pwdInput = document.getElementById('passwordModalInput');
            if (pwdInput) {
                pwdInput.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter') executePasswordModal();
                });
            }
            const confirmModal = document.getElementById('confirmModal');
            if (confirmModal) {
                confirmModal.addEventListener('click', function(e) {
                    if (e.target === this) hideConfirm();
                });
            }
        });

        function logoutAdmin() {
            showConfirm(tAdmin('confirmLogout') || '确认退出登录吗？', function() {
                try { stopAdminCallPolling(); } catch(e) {}
                try { stopAutoPrintPoll(); } catch(e) {}
                adminToken = '';
                SLF.store.rawRemoveSession('adminToken');
                window.location.href = '/login';
            });
        }

        async function loadAdminInfo() {
            try {
                const data = await api('/admin/info');
                if (data.admin) {
                    $('#adminDisplayName').textContent = data.admin.username || tAdmin('account');
                    $('#adminInfoUsername').textContent = data.admin.username || '-';
                    $('#adminInfoMerchant').textContent = data.merchant?.name || '-';
                    $('#adminInfoCode').textContent = data.merchant?.code || '-';
                    $('#adminInfoStoreCount').textContent = (data.storeCount || 0) + ' / ' + (data.merchant?.max_stores || 0);
                    const _contact = (data.merchant?.contact_name || '').trim();
                    $('#adminInfoContact').textContent = _contact === '管理员' ? tAdmin('admin') : (_contact || '-');
                    $('#adminInfoPhone').textContent = data.merchant?.contact_phone || '-';
                    $('#adminInfoStatus').textContent = data.merchant?.status ? tAdmin('storeActive') : tAdmin('storeDisabled');
                    $('#adminInfoStatus').style.color = data.merchant?.status ? '#2ecc71' : '#e74c3c';
                    $('#adminInfoStatus').style.fontWeight = '600';
                    $('#adminInfoCreated').textContent = data.merchant?.created_at ? SLF.utils.formatDateTime(data.merchant.created_at) : (data.admin.created_at ? SLF.utils.formatDateTime(data.admin.created_at) : '-');
                }
            } catch (e) { console.warn('加载账户信息失败', e); }
        }
        // (showAdminInfo/hideAdminInfo 已移到 shared.js)
        document.addEventListener('DOMContentLoaded', function() {
            const adminInfoModal = document.getElementById('adminInfoModal');
            if (adminInfoModal) {
                adminInfoModal.addEventListener('click', function(e) {
                    if (e.target === this) hideAdminInfo();
                });
            }
        });

        async function loadReportSummary() {
            try {
                const data = await api('/admin/reports/summary');
                $('#todayRevenueAmount').textContent = SLF.money.primary(data.today.revenue);
                $('#todayRevenueOrders').textContent = data.today.orders + ' ' + tAdmin('ordersCount');
                $('#monthRevenueAmount').textContent = SLF.money.primary(data.month.revenue);
                $('#monthRevenueOrders').textContent = data.month.orders + ' ' + tAdmin('ordersCount');
                const list = $('#hotDishesList');
                if (data.topDishes && data.topDishes.length > 0) {
                    list.innerHTML = data.topDishes.map((d, i) => {
                        const rankClass = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-other';
                        const rankText = i < 3 ? ['🥇','🥈','🥉'][i] : (i + 1);
                        return `<div class="hot-dish-item">
                            <div class="hot-dish-rank ${rankClass}">${rankText}</div>
                            <span class="hot-dish-emoji">${d.emoji || '🍽️'}</span>
                            <span class="hot-dish-name">${esc(d.name)}</span>
                            <span class="hot-dish-sales">${d.sales_count}</span>
                        </div>`;
                    }).join('');
                } else {
                    list.innerHTML = `<div style="text-align:center;color:#9c9cb2;padding:20px;font-size:13px;">${tAdmin('noHotDishes') || '暂无热销数据'}</div>`;
                }
            } catch (e) { console.warn('加载营业汇总失败', e); }
        }

        // 初始化
        let adminCallPollTimer = null;
        (async function() {
            if (adminLang !== 'zh') await loadAdminLanguage(adminLang);
            applyAdminLanguage();
        })();

        if (adminToken) {
            $('#dashboard').hidden = false;
            $('#logoutBtn').hidden = false;
            $('#adminNameBtn').hidden = false;
            loadAdminInfo();
            window.loadStores();
            SLF.api.get('/public/global-config').then(cfg => {
                if (cfg.admin_idle_timeout && cfg.admin_idle_timeout > 0) {
                    SLF.idle.update(cfg.admin_idle_timeout, adminIdleLogout);
                }
            }).catch(err => console.warn('[空闲超时] 加载配置失败:', err.message));
            refresh().catch(() => {
                SLF.store.rawRemoveSession('adminToken');
                window.location.href = '/login';
            });
            applyPermissions();
            startAdminCallPolling();
        } else {
            window.location.href = '/login';
        }

        // 分类拖拽排序
        let draggedCategoryRow = null;
        document.addEventListener('dragstart', (e) => {
            const row = e.target.closest('.category-row');
            if (row) {
                draggedCategoryRow = row;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', row.dataset.id);
                row.style.opacity = '0.5';
            }
        });
        document.addEventListener('dragend', (e) => {
            const row = e.target.closest('.category-row');
            if (row) row.style.opacity = '';
        });
        document.addEventListener('dragover', (e) => e.preventDefault());
        document.addEventListener('drop', async (e) => {
            e.preventDefault();
            const targetRow = e.target.closest('.category-row');
            if (targetRow && draggedCategoryRow && targetRow !== draggedCategoryRow) {
                const container = document.getElementById('categoryList');
                const children = Array.from(container.children);
                const dragIndex = children.indexOf(draggedCategoryRow);
                const targetIndex = children.indexOf(targetRow);
                if (dragIndex < targetIndex) {
                    container.insertBefore(draggedCategoryRow, targetRow.nextSibling);
                } else {
                    container.insertBefore(draggedCategoryRow, targetRow);
                }
                const newOrder = Array.from(container.querySelectorAll('.category-row')).map(row => parseInt(row.dataset.id));
                try {
                    await api('/menu-categories/sort', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { ids: newOrder } });
                    SLF.ui.toast(`✅ ${tAdmin('categorySortUpdated')}`);
                    await window.loadMenuCategories();
                } catch (err) {
                    SLF.ui.toast(`❌ ${tAdmin('updateFailed')}: ` + err.message);
                    await window.loadMenuCategories();
                }
            }
            if (draggedCategoryRow) {
                draggedCategoryRow.style.opacity = '';
                draggedCategoryRow = null;
            }
        });

        // 预约管理
        async function loadReservations() {
            try {
                const data = await api('/admin/reservations');
                const container = $('#reservationsList');
                if (!data || data.length === 0) {
                    container.innerHTML = `<div style="text-align:center;padding:40px;color:#c8c8d0;">${tAdmin('noReservations')}</div>`;
                    return;
                }
                const statusMap = { pending: tAdmin('reservationPending'), confirmed: tAdmin('reservationConfirmed'), canceled: tAdmin('reservationCanceled'), completed: tAdmin('reservationCompleted') };
                const statusColor = { pending: '#ffb020', confirmed: '#2ecc71', canceled: '#999', completed: '#3498db' };
                container.innerHTML = data.map(r => `
                    <div style="background:rgba(255,255,255,.05);border-radius:12px;padding:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
                        <div>
                            <div style="font-weight:700;font-size:16px;">🪑 ${esc(r.table_name)} · ${esc(r.customer_name)}</div>
                            <div style="color:#c8c8d0;font-size:13px;margin-top:4px;">📅 ${esc(r.reservation_time)} · 👥 ${r.guests} ${tAdmin('guestsUnit') || ''} · 📞 ${esc(r.phone || tAdmin('noPhone'))}</div>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span style="padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;background:${statusColor[r.status] || '#999'}22;color:${statusColor[r.status] || '#999'};">${statusMap[r.status] || r.status}</span>
                            ${r.status === 'pending' ? `
                                <button onclick="updateReservation(${r.id}, 'confirmed')" style="background:#2ecc71;color:#fff;border:0;padding:6px 14px;border-radius:8px;cursor:pointer;">${tAdmin('confirm')}</button>
                                <button onclick="updateReservation(${r.id}, 'canceled')" style="background:#e74c3c;color:#fff;border:0;padding:6px 14px;border-radius:8px;cursor:pointer;">${tAdmin('cancel')}</button>
                            ` : ''}
                            ${r.status === 'confirmed' ? `<button onclick="updateReservation(${r.id}, 'completed')" style="background:#3498db;color:#fff;border:0;padding:6px 14px;border-radius:8px;cursor:pointer;">${tAdmin('complete')}</button>` : ''}
                        </div>
                    </div>
                `).join('');
            } catch (err) {
                SLF.ui.toast(tAdmin('loadReservationsFailed') + ': ' + err.message);
            }
        }

        // (updateReservation 已移到 shared.js)

        // 呼叫服务员
        let knownAdminCallIds = new Set();
        async function pollAdminCalls() {
            if (document.hidden) return;
            try {
                const calls = await api('/waiter-calls');
                const badge = document.getElementById('callsBadge');
                if (calls && calls.length > 0) {
                    badge.style.display = 'inline-block';
                    badge.textContent = calls.length;
                    let hasNew = false;
                    for (const c of calls) { if (!knownAdminCallIds.has(c.id)) { hasNew = true; break; } }
                    if (hasNew) {
                        try {
                            const ctx = new (window.AudioContext || window.webkitAudioContext)();
                            const now = ctx.currentTime;
                            [[0, 1000], [0.2, 1400], [0.4, 1000]].forEach(([t, freq]) => {
                                const osc = ctx.createOscillator();
                                const gain = ctx.createGain();
                                osc.connect(gain); gain.connect(ctx.destination);
                                osc.frequency.value = freq; osc.type = 'sine';
                                gain.gain.setValueAtTime(0.0001, now + t);
                                gain.gain.exponentialRampToValueAtTime(0.4, now + t + 0.02);
                                gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.25);
                                osc.start(now + t); osc.stop(now + t + 0.3);
                            });
                        } catch (e) {}
                        const newCall = calls.find(c => !knownAdminCallIds.has(c.id));
                        if (newCall) {
                            const typeText = newCall.type === 'urge' ? tAdmin('urgeOrder') : tAdmin('callWaiter');
                            SLF.ui.toast('🔔 ' + newCall.table_name + ' ' + typeText);
                        }
                    }
                    knownAdminCallIds = new Set(calls.map(c => c.id));
                } else {
                    badge.style.display = 'none';
                    knownAdminCallIds.clear();
                }
            } catch (e) { /* 静默失败 */ }
        }
        function startAdminCallPolling() {
            stopAdminCallPolling();
            adminCallPollTimer = setInterval(pollAdminCalls, 5000);
            pollAdminCalls();
        }
        function stopAdminCallPolling() {
            if (adminCallPollTimer) clearInterval(adminCallPollTimer);
            adminCallPollTimer = null;
        }

        // ===== 呼叫服务员+报表（已移到 pages/admin/report.js）=====


        // 打印机管理
        function toggleAutoPrint() {
            const enabled = document.getElementById('autoPrintToggle').checked;
            SLF.store.rawSet('autoPrintEnabled', enabled ? '1' : '0');
            SLF.ui.toast(enabled ? (tAdmin('autoPrintEnabled') || '已开启自动打印') : (tAdmin('autoPrintDisabled') || '已关闭自动打印'));
            if (enabled) startAutoPrintPoll();
            else stopAutoPrintPoll();
        }
        function startAutoPrintPoll() {
            if (autoPrintPollTimer) return;
            if (ordersCache.length) ordersCache.forEach(o => printedOrders.add(o.id));
            autoPrintPollTimer = setInterval(checkNewOrdersAndPrint, 15000);
        }
        function stopAutoPrintPoll() {
            if (autoPrintPollTimer) { clearInterval(autoPrintPollTimer); autoPrintPollTimer = null; }
        }
        async function checkNewOrdersAndPrint() {
            try {
                const orders = await api('/orders');
                const newOrders = orders.filter(o => o.status === 'pending' && !printedOrders.has(o.id));
                for (const order of newOrders) {
                    printedOrders.add(order.id);
                    try {
                        const data = await api('/orders/' + order.id + '/print', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: {} });
                        if (data.printData) printViaBrowser(data.printData, order.id);
                    } catch (e) { console.error('自动打印失败:', e); }
                }
            } catch (e) { console.error('检查新订单失败:', e); }
        }
        document.addEventListener('DOMContentLoaded', function() {
            const saved = SLF.store.rawGet('autoPrintEnabled');
            const toggle = document.getElementById('autoPrintToggle');
            if (toggle) toggle.checked = saved === '1';
            if (saved === '1') setTimeout(startAutoPrintPoll, 3000);
        });

        // ===== 打印机管理（已移到 pages/admin/printer.js）=====


        // ===== 打印（已移到 pages/admin/printer.js）=====


        // (loadDailyReport/exportData 已移到 report.js)

        // Socket 事件（带 token 与防抖）
        if (typeof io === 'function') {
            const adminSocket = io({
                query: {
                    storeId: SLF.store.rawGet('storeId') || 1,
                    token: SLF.store.rawGetSession('adminToken') || ''
                }
            });
            let socketDebounce = null;
            function debouncedLoadOrders() {
                clearTimeout(socketDebounce);
                socketDebounce = setTimeout(() => {
                    if (typeof loadOrders === 'function') window.loadOrders();
                }, 300);
            }
            adminSocket.on('order:new', debouncedLoadOrders);
            adminSocket.on('item:updated', debouncedLoadOrders);
            adminSocket.on('order:settled', debouncedLoadOrders);
            adminSocket.on('order:transfer', debouncedLoadOrders);
            adminSocket.on('connect_error', (err) => {
                console.warn('adminSocket connect_error:', err.message);
            });
            window.addEventListener('beforeunload', () => {
                try { adminSocket.disconnect(); } catch (_) {}
            });
        }
    try { window.addPrinter = addPrinter; } catch(err) {}
    try { window.closeAddAdminModal = closeAddAdminModal; } catch(err) {}
    try { window.closeAdminEdit = closeAdminEdit; } catch(err) {}
    try { window.closeCashierModal = closeCashierModal; } catch(err) {}
    try { window.closeCategoryEditModal = closeCategoryEditModal; } catch(err) {}
    try { window.closeCategoryModal = closeCategoryModal; } catch(err) {}
    try { window.closeCurrencyEdit = closeCurrencyEdit; } catch(err) {}
    try { window.closeDishModal = closeDishModal; } catch(err) {}
    try { window.closeOrderForm = closeOrderForm; } catch(err) {}
    try { window.closePrinterEdit = closePrinterEdit; } catch(err) {}
    try { window.closeSettleDetail = closeSettleDetail; } catch(err) {}
    try { window.closeSidebar = closeSidebar; } catch(err) {}
    try { window.closeStoreEdit = closeStoreEdit; } catch(err) {}
    try { window.closeTableForm = closeTableForm; } catch(err) {}
    try { window.closeTransferModal = closeTransferModal; } catch(err) {}
    try { window.closeWaiterEdit = closeWaiterEdit; } catch(err) {}
    try { window.confirmCancelOrder = confirmCancelOrder; } catch(err) {}
    try { window.confirmSettleOrder = confirmSettleOrder; } catch(err) {}
    try { window.confirmTransfer = confirmTransfer; } catch(err) {}
    try { window.copyStoreMenu = copyStoreMenu; } catch(err) {}
    try { window.deleteAdmin = deleteAdmin; } catch(err) {}
    try { window.deleteCashier = deleteCashier; } catch(err) {}
    try { window.deleteCategory = deleteCategory; } catch(err) {}
    try { window.deletePrinter = deletePrinter; } catch(err) {}
    try { window.deleteStore = deleteStore; } catch(err) {}
    try { window.deleteWaiter = deleteWaiter; } catch(err) {}
    try { window.doSettleOrder = doSettleOrder; } catch(err) {}
    try { window.editAdmin = editAdmin; } catch(err) {}
    try { window.editCashier = editCashier; } catch(err) {}
    try { window.editCategory = editCategory; } catch(err) {}
    try { window.editCurrency = editCurrency; } catch(err) {}
    try { window.editMenu = editMenu; } catch(err) {}
    try { window.editOrder = editOrder; } catch(err) {}
    try { window.editTable = editTable; } catch(err) {}
    try { window.esc = esc; } catch(err) {}
    try { window.executeConfirm = executeConfirm; } catch(err) {}
    try { window.executePasswordModal = executePasswordModal; } catch(err) {}
    try { window.exportData = exportData; } catch(err) {}
    try { window.handleWaiterCall = handleWaiterCall; } catch(err) {}
    try { window.hideAdminInfo = hideAdminInfo; } catch(err) {}
    try { window.hideConfirm = hideConfirm; } catch(err) {}
    try { window.hidePasswordModal = hidePasswordModal; } catch(err) {}
    try { window.loadDailyReport = loadDailyReport; } catch(err) {}
    try { window.loadWaiterCalls = loadWaiterCalls; } catch(err) {}
    try { window.logoutAdmin = logoutAdmin; } catch(err) {}
    try { window.openAddAdminModal = openAddAdminModal; } catch(err) {}
    try { window.openAddCashierModal = openAddCashierModal; } catch(err) {}
    try { window.openCategoryModal = openCategoryModal; } catch(err) {}
    try { window.openDishModal = openDishModal; } catch(err) {}
    try { window.openOrderForm = openOrderForm; } catch(err) {}
    try { window.openPrinterEdit = openPrinterEdit; } catch(err) {}
    try { window.openStoreEdit = openStoreEdit; } catch(err) {}
    try { window.openWaiterEdit = openWaiterEdit; } catch(err) {}
    try { window.printOrder = printOrder; } catch(err) {}
    try { window.removeCurrency = removeCurrency; } catch(err) {}
    try { window.removeMenu = removeMenu; } catch(err) {}
    try { window.removeOrder = removeOrder; } catch(err) {}
    try { window.removeOrderItem = removeOrderItem; } catch(err) {}
    try { window.removeTable = removeTable; } catch(err) {}
    try { window.saveAdminEdit = saveAdminEdit; } catch(err) {}
    try { window.saveCategoryEdit = saveCategoryEdit; } catch(err) {}
    try { window.saveCurrencyEdit = saveCurrencyEdit; } catch(err) {}
    try { window.saveOrderPrefixes = saveOrderPrefixes; } catch(err) {}
    try { window.savePrinterEdit = savePrinterEdit; } catch(err) {}
    try { window.setDefaultCurrency = setDefaultCurrency; } catch(err) {}
    try { window.setDefaultPrinter = setDefaultPrinter; } catch(err) {}
    try { window.showAdminInfo = showAdminInfo; } catch(err) {}
    try { window.showQr = showQr; } catch(err) {}
    try { window.showTransferModal = showTransferModal; } catch(err) {}
    try { window.submitAddAdmin = submitAddAdmin; } catch(err) {}
    try { window.switchAdminModule = switchAdminModule; } catch(err) {}
    try { window.switchLogTab = switchLogTab; } catch(err) {}
    try { window.switchMenuTab = switchMenuTab; } catch(err) {}
    try { window.testPrinter = testPrinter; } catch(err) {}
    try { window.toggleItemStatus = toggleItemStatus; } catch(err) {}
    try { window.toggleMenuStatus = toggleMenuStatus; } catch(err) {}
    try { window.togglePrinter = togglePrinter; } catch(err) {}
    try { window.toggleSidebar = toggleSidebar; } catch(err) {}
    try { window.updateReservation = updateReservation; } catch(err) {}

    // ===== 共享上下文（供后续拆分模块使用）=====
    try {
      window.SLF.admin = {
        $, api, tAdmin, L, esc, hasPermission, applyPermissions,
        get adminToken() { return adminToken; },
        get adminId() { return adminId; },
        get adminIsPrimary() { return adminIsPrimary; },
        get adminPermissions() { return adminPermissions; },
        menusCache: () => menusCache,
        tablesCache: () => tablesCache,
        ordersCache: () => ordersCache,
        currenciesCache: () => currenciesCache,
        categoriesCache: () => categoriesCache,
        setMenus: (v) => menusCache = v,
        setCategories: (v) => categoriesCache = v,
        setTables: (v) => tablesCache = v,
        setOrders: (v) => ordersCache = v,
        dualCurrencyEnabled: () => dualCurrencyEnabled,
        secondaryCurrencyCode: () => secondaryCurrencyCode,
        defaultCurrencyObj: () => defaultCurrencyObj,
        setDualCurrency: (v) => dualCurrencyEnabled = v,
        setSecondaryCurrencyCode: (v) => secondaryCurrencyCode = v,
        setDefaultCurrencyObj: (v) => defaultCurrencyObj = v,
        buildSessionLabels,
        showConfirm
      };
    } catch(err) {}
})();
