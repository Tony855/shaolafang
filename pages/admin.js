/*
 * FoodFlow · admin 页面逻辑（由内联脚本抽出，onclick 函数挂 window）
 */
(function(){
'use strict';
        // 全局状态
        const api = async (path, opts = {}) => {
            if (opts.method && opts.method !== 'GET') {
                return SLF.api.request(path, { method: opts.method, body: opts.body });
            }
            return SLF.api.get(path);
        };
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
            const settingsCardPerms = {
                adminManageCard: 'can_manage_admin',
                cashierManageCard: 'can_manage_cashier',
                waiterManageCard: 'can_manage_waiter',
                currencySettingsCard: 'can_manage_currency',
                printerSettingsCard: 'can_manage_printer'
            };
            for (const [cid, perm] of Object.entries(settingsCardPerms)) {
                const card = document.getElementById(cid);
                if (card) card.style.display = hasPermission(perm) ? '' : 'none';
            }
        }

        let menusCache = [];
        let tablesCache = [];
        let ordersCache = [];
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

        const tAdmin = SLF.t;
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


        // ===== 菜品表单提交（已移到 menu.js）=====


        // (removeTable/editTable/openTableForm/closeTableForm 已移到 table.js)

        // ===== 桌台表单提交（已移到 table.js）=====


        window.filterOrders = function() {
            window.orderTableFilter = $('#orderTableSearch').value.trim();
            if (window.loadOrders) window.loadOrders();
        }

        // ===== 订单操作（已移到 pages/admin/order.js）=====


        // ===== 订单编辑表单（已移到 pages/admin/order.js）=====


        // ===== 订单表单提交（已移到 order.js）=====


        // (editCurrency/saveCurrencyEdit/setDefaultCurrency/removeCurrency 已移到 currency.js)
        // ===== 货币表单提交（已移到 currency.js）=====


        // (updateWaiterPerm/deleteWaiter 已移到 waiter.js)
        // ===== 服务员表单提交（已移到 waiter.js）=====


        // (deleteStore/copyStoreMenu 已移到 store.js)
        // ===== 店铺表单提交（已移到 store.js）=====


        // (showQr 已移到 table.js)

        // ===== 显示设置表单（已移到 settings.js）=====
        // ===== resetDataBtn（已移到 shared.js）=====


        // ===== 服务员编辑功能（已移到 waiter.js）=====


        // ===== 服务员编辑表单（已移到 waiter.js）=====


        // ===== 店铺编辑功能（已移到 store.js）=====


        // ===== 店铺编辑表单（已移到 store.js）=====


        // ===== updateOrderSummary/getCurrentModule/switchAdminModule/toggleSidebar/closeSidebar（已移到 shared.js）=====


        // ===== 汉堡按钮拖动（已移到 shared.js）=====


        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.addEventListener('click', function() {
                const module = this.dataset.module;
                window.switchAdminModule(module);
                if (window.innerWidth <= 1024) window.closeSidebar();
            });
        });

        async function refresh() {
            try {
                await window.loadCurrencies();
                await window.loadMenuCategories();
                await window.loadStores();
                await loadDisplaySettings();
                await loadOrderPrefixes();
                await loadNotificationSettings();
                const loadTasks = [window.loadMenus(), window.loadTables(), window.loadOrders(), loadLoginLogs()];
                if (hasPermission('can_manage_admin')) loadTasks.push(window.loadAdmins());
                if (hasPermission('can_view_logs')) loadTasks.push(loadAuditLogs());
                await Promise.all(loadTasks);
                const currentModule = window.getCurrentModule();
                if (currentModule) switchAdminModule(currentModule);
            } catch (e) {
                SLF.ui.toast('❌ ' + e.message);
                throw e;
            }
        }

                function applyDataI18n() {
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (!key) return;
                const translated = tAdmin(key);
                if (translated && translated !== key) el.textContent = translated;
            });
            document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
                const key = el.getAttribute('data-i18n-placeholder');
                if (!key) return;
                const translated = tAdmin(key);
                if (translated && translated !== key) el.placeholder = translated;
            });
            document.querySelectorAll('[data-i18n-title]').forEach(el => {
                const key = el.getAttribute('data-i18n-title');
                if (!key) return;
                const translated = tAdmin(key);
                if (translated && translated !== key) el.title = translated;
            });
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

            // ===== 语言切换后：重新渲染当前模块的列表 =====
            // 打印机列表（按钮/开关文案跟随语言）
            try {
                if (document.getElementById('module-printers') && document.getElementById('module-printers').classList.contains('active')) {
                    if (window.loadPrinters) window.loadPrinters();
                }
            } catch (e) { console.warn('reload printers failed', e); }
            // 其他已渲染的列表也可以在这里重载（管理员列表、服务员列表等）
            try {
                if (document.getElementById('module-admins') && document.getElementById('module-admins').classList.contains('active')) {
                    if (window.loadAdmins) window.loadAdmins();
                }
                if (document.getElementById('module-cashiers') && document.getElementById('module-cashiers').classList.contains('active')) {
                    if (window.loadCashiers) window.loadCashiers();
                }
                if (document.getElementById('module-waiters') && document.getElementById('module-waiters').classList.contains('active')) {
                    if (window.loadWaiters) window.loadWaiters();
                }
                if (document.getElementById('module-stores') && document.getElementById('module-stores').classList.contains('active')) {
                    if (window.loadStores) window.loadStores();
                }
                if (document.getElementById('module-currencies') && document.getElementById('module-currencies').classList.contains('active')) {
                    if (window.loadCurrencies) window.loadCurrencies();
                }
            } catch (e) { console.warn('reload module failed', e); }

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
            // 订单管理 3 Tab i18n（与收银端同 key）
            const _ot = (id, key, fb) => { const el = document.getElementById(id); if (el) el.textContent = tAdmin(key) || fb; };
            _ot('orderTabPendingText',  'pendingOrders', '未结算订单');
            _ot('orderTabSettledText',  'settledOrders', '已结订单');
            _ot('orderTabRefundedText', 'refundOrder',   '退款订单');
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
            $('#autoPrintTitle').textContent = tAdmin('autoPrintTitle') || '下单自动打印后厨单';
            $('#autoPrintDesc').textContent = tAdmin('autoPrintDesc') || '开启后，顾客下单时自动打印后厨单到默认打印机';
            const _rt = document.getElementById('autoPrintReceiptTitle');
            if (_rt) _rt.textContent = tAdmin('autoPrintReceiptTitle') || '结算自动打印收银小票';
            const _rd = document.getElementById('autoPrintReceiptDesc');
            if (_rd) _rd.textContent = tAdmin('autoPrintReceiptDesc') || '开启后，收银员结算时自动打印小票到默认打印机';
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
            const _cst = $('#cashierStoreLabel'); if (_cst) _cst.textContent = tAdmin('cashierStoreLabel');
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

            // ===== 补充未覆盖的 UI 元素（2026-09-29 补丁）=====
            const _st = (id, key) => { const el = document.getElementById(id); if (el) el.textContent = tAdmin(key); };
            const _sp = (id, key) => { const el = document.getElementById(id); if (el) el.placeholder = tAdmin(key); };

            _st('menuTabDishText', 'menuManage');
            _st('categoryBtnText', 'menuCategory');
            _st('importMenuBtn', 'importMenuBtn');
            _st('printerEditTitle', 'printerEditTitle');
            _st('printerEditNameLabel', 'printerName');
            _st('printerEditTypeLabel', 'connectionType');
            _st('printerEditIpLabel', 'ipAddress');
            _st('printerEditPortLabel', 'port');
            _st('printerEditWidthLabel', 'paperWidth');
            _st('printerEditBrandLabel', 'printerEditBrandLabel');
            _st('printerEditDefaultLabel', 'setAsDefault');
            _st('printerEditCancelBtn', 'cancel');
            _st('printerEditSaveBtn', 'save');
            _st('logTabLoginText', 'loginLogs');
            _st('logTabAuditText', 'operationLogs');
            _st('waiterManageCardTitle', 'waiterManageCardTitle');
            _st('waiterManageDesc', 'waiterManageDesc');
            _st('enterWaiterManageBtn', 'enterWaiterManage');
            _st('currencySettingsTitle', 'currencySettingsTitle');
            _st('currencySettingsDesc', 'currencySettingsDesc');
            _st('enterCurrencySettingsBtn', 'enterCurrencySettingsBtn');
            _st('printerSettingsTitle', 'printerSettingsTitle');
            _st('printerSettingsDesc', 'printerSettingsDesc');
            _st('enterPrinterSettingsBtn', 'enterPrinterSettingsBtn');
            _st('orderResetPeriodLabel', 'orderNoResetPeriod');
            _st('oldPasswordLabel', 'oldPassword');
            _st('orderModalTitle', 'addOrder');
            _st('tableModalTitle', 'editTable');
            _st('categoryEditModalTitle', 'editCategory');
            _st('categoryEditNameLabel', 'categoryName');
            _st('categoryCancelBtn', 'cancel');
            _st('cashierModalTitle', 'cashierModalTitle');
            _st('cashierUsernameLabel', 'cashierUsername');
            _st('cashierNameLabel', 'cashierDisplayName');
            _st('cashierPasswordLabel', 'passwordEditHint');
            _st('cashierActiveLabel', 'accountActive');
            _st('cashierActiveSub', 'activeDesc');
            _st('cashierPermTitle', 'permissionConfig');
            _st('cashierCanSettleLabel', 'settleOrder');
            _st('cashierCanSettleSub', 'canSettleDesc');
            _st('cashierCanCancelLabel', 'cancelOrder');
            _st('cashierCanCancelSub', 'canCancelDesc');
            _st('cashierCanRefundLabel', 'refund');
            _st('cashierCanRefundSub', 'canRefundDesc');
            _st('cashierCanViewReportLabel', 'viewReport');
            _st('cashierCanViewReportSub', 'canViewReportDesc');
            _st('cashierCancelButton', 'cancel');
            _st('cashierSaveButton', 'save');
            _st('waiterEditTitle', 'editWaiter');
            _st('storeEditTitle', 'editStore');
            _st('confirmMessage', 'confirmMessage');
            _st('settleDetailTitle', 'settleOrder');
            _st('confirmImportBtn', 'confirmImportBtn');
            _st('confirmImportYesBtn', 'confirmImportYesBtn');

            // ===== 2026-09-29 补齐弹窗按钮/标题的 i18n =====
            _st('addAdminCancelBtn', 'cancel');
            _st('addAdminSaveBtn', 'save');
            _st('settleDetailCancelBtn', 'cancel');
            _st('settleDetailOkBtn', 'settleNow');
            _st('importModalTitle', 'importMenuTitle');
            _st('importModalDesc', 'importMenuDesc');
            _st('downloadTemplateLink', 'downloadTemplate');
            _st('importModalCancelBtn', 'cancel');
            _st('confirmImportModalTitle', 'confirmImportTitle');
            _st('confirmImportModalCancelBtn', 'cancel');

            // ===== 2026-09-29 补齐 placeholder 的 i18n =====
            const _ph = (id, key) => { const el = document.getElementById(id); if (el) el.placeholder = tAdmin(key); };
            _ph('tableName', 'tableNamePlaceholder');
            _ph('orderTableSearch', 'orderSearchInputPlaceholder');
            _ph('currencyCode', 'currencyCodePlaceholder');
            _ph('currencySymbol', 'currencySymbolPlaceholder');
            _ph('currencyName', 'currencyNamePlaceholder');
            _ph('currencyRate', 'currencyRateLabel');
            _ph('printerName', 'printerNamePlaceholder');
            _ph('printerIp', 'ipPlaceholder');
            _ph('waiterUsernameInput', 'accountRequired');
            _ph('waiterPasswordInput', 'enterPassword');
            _ph('waiterNameInput', 'cashierDisplayNamePlaceholder');
            _ph('storeNameInput', 'enterStoreName');
            _ph('storeCodeInput', 'storeCodePlaceholder');
            _ph('storeAddressInput', 'storeAddressPlaceholderInput');
            _ph('oldPassword', 'enterOldPassword');
            _ph('newPassword', 'newPasswordHint6');
            _ph('menuName', 'dishName');
            _ph('menuNameEn', 'nameEn');
            _ph('menuPrice', 'price');
            _ph('menuUnit', 'unit');
            _ph('menuEmoji', 'icon');
            _ph('menuDesc', 'desc');
            _ph('menuDescEn', 'descEn');
            _ph('newCategoryName', 'newCategoryName');
            _ph('orderNoteField', 'customerNoteOptional');
            _ph('editCategoryName', 'categoryNamePlaceholder');
            _ph('editCurrencyName', 'currencyName');
            _ph('editCurrencySymbol', 'symbolLabel');
            _ph('cashierUsername', 'cashierUsernamePlaceholder');
            _ph('cashierPassword', 'passwordMin6');
            _ph('editWaiterPassword', 'waiterPasswordPlaceholder');
            _ph('editAdminDisplayName', 'editAdminDisplayNamePlaceholder');
            _ph('editAdminPassword', 'pleaseEnterNewPassword');
            _ph('editStoreAddress', 'storeAddressPlaceholder');

            // ===== 2026-09-29 补齐 select option 的 i18n =====
            const _opt = (selId, idx, key) => {
              const sel = document.getElementById(selId);
              if (sel && sel.options[idx]) sel.options[idx].text = tAdmin(key);
            };

            // 菜单分类筛选：第一项"全部分类"（其余项由 populateMenuCategorySelect 动态处理）
            _opt('menuCategoryFilter', 0, 'menuAllCategoriesOption');

            // 菜单排序方式（5 项）
            _opt('menuSortBy', 0, 'defaultSort');
            _opt('menuSortBy', 1, 'nameAsc');
            _opt('menuSortBy', 2, 'nameDesc');
            _opt('menuSortBy', 3, 'priceAsc');
            _opt('menuSortBy', 4, 'priceDesc');

            // 打印机类型（新增表单 + 编辑表单）
            _opt('printerType', 0, 'networkPrinter');
            _opt('printerType', 1, 'usbPrinter');
            _opt('printerType', 2, 'bluetoothPrinter');
            _opt('editPrinterType', 0, 'networkPrinter');
            _opt('editPrinterType', 1, 'usbPrinter');
            _opt('editPrinterType', 2, 'bluetoothPrinter');

            // 打印机纸宽
            _opt('printerWidth', 0, 'paper58mm');
            _opt('printerWidth', 1, 'paper80mm');
            _opt('editPrinterWidth', 0, 'paper58mm');
            _opt('editPrinterWidth', 1, 'paper80mm');

            // 打印机品牌（新增表单 8 项）
            _opt('printerBrand', 0, 'genericEscPos');
            _opt('printerBrand', 1, 'epson');
            _opt('printerBrand', 2, 'star');
            _opt('printerBrand', 3, 'bixolon');
            _opt('printerBrand', 4, 'jiabo');
            _opt('printerBrand', 5, 'xprinter');
            _opt('printerBrand', 6, 'rongta');
            _opt('printerBrand', 7, 'hoin');
            // 编辑表单品牌（5 项）
            _opt('editPrinterBrand', 0, 'genericEscPos');
            _opt('editPrinterBrand', 1, 'epson');
            _opt('editPrinterBrand', 2, 'bixolon');
            _opt('editPrinterBrand', 3, 'rongta');
            _opt('editPrinterBrand', 4, 'xprinter');

            // 订单号重置周期（4 项）
            _opt('orderResetPeriod', 0, 'orderNoResetDailyFull');
            _opt('orderResetPeriod', 1, 'orderNoResetMonthlyFull');
            _opt('orderResetPeriod', 2, 'orderNoResetYearlyFull');
            _opt('orderResetPeriod', 3, 'orderNoResetNeverFull');

            // 桌号状态（3 项）
            _opt('editTableStatus', 0, 'available');
            _opt('editTableStatus', 1, 'occupied');
            _opt('editTableStatus', 2, 'reserved');
        
            try { applyDataI18n(); } catch(e) { console.warn('applyDataI18n failed', e); }
        }

        // ===== 语言切换和店铺切换（已移到 shared.js）=====


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

        // ===== 密码弹窗和确认弹窗（已移到 shared.js）=====


        function logoutAdmin() {
            showConfirm(tAdmin('confirmLogout') || '确认退出登录吗？', function() {
                try { stopAdminCallPolling(); } catch(e) {}
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
        // ===== adminInfoModal（已移到 shared.js）=====


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

            console.log("adminToken:", adminToken); if (adminToken) {
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
            refresh().catch((err) => { console.error("refresh failed:", err); SLF.store.rawRemoveSession("adminToken"); window.location.href = "/login"; });



            applyPermissions();
            startAdminCallPolling();
            } else {
                window.location.href = '/login';
            }
        })();

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
                    if (badge) {
                      badge.style.display = 'inline-block';
                      badge.textContent = calls.length;
                    }
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
        async function toggleAutoPrint() {
            const enabled = document.getElementById('autoPrintToggle').checked;
            try {
                await SLF.api.post('/admin/settings/auto-print', {
                    enabled: enabled,
                    type: 'kitchen'
                });
                SLF.ui.toast(enabled ? (tAdmin('autoPrintEnabled') || '已开启自动打印') : (tAdmin('autoPrintDisabled') || '已关闭自动打印'));
            } catch (e) {
                SLF.ui.toast('❌ ' + (e.message || '保存失败'));
                document.getElementById('autoPrintToggle').checked = !enabled;
            }
        }

        async function toggleAutoPrintReceipt() {
            const enabled = document.getElementById('autoPrintReceiptToggle').checked;
            try {
                await SLF.api.post('/admin/settings/auto-print', {
                    enabled: enabled,
                    type: 'receipt'
                });
                SLF.ui.toast(enabled ? (tAdmin('autoPrintEnabled') || '已开启自动打印') : (tAdmin('autoPrintDisabled') || '已关闭自动打印'));
            } catch (e) {
                SLF.ui.toast('❌ ' + (e.message || '保存失败'));
                document.getElementById('autoPrintReceiptToggle').checked = !enabled;
            }
        }
        
        // ===== 自动打印开关（已移到 printer.js）=====


        // ===== 打印机管理（已移到 pages/admin/printer.js）=====


        // ===== 打印（已移到 pages/admin/printer.js）=====


        // (loadDailyReport/exportData 已移到 report.js)

        // Socket 事件（带 token 与防抖）
        if (typeof io === 'function') {
            const adminSocket = io({
                query: {
                    storeId: SLF.store.rawGetSession('adminStoreId') || SLF.store.rawGet('storeId') || 1,
                    token: SLF.store.rawGetSession('adminToken') || ''
                }
            });
            window._adminSocket = adminSocket;
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
            adminSocket.on('table:moved', debouncedLoadOrders);
            adminSocket.on('connect', () => {
                console.log('[admin] socket 已连接');
                if (typeof window.refresh === 'function') {
                    // 重连后补偿一次刷新（静默）
                    setTimeout(() => { try { window.refresh(); } catch(_) {} }, 100);
                }
            });
            adminSocket.on('disconnect', () => {
                console.warn('[admin] socket 断开，10 秒后自动重连');
            });
            adminSocket.on('connect_error', (err) => {
                console.warn('adminSocket connect_error:', err.message);
            });
            window.addEventListener('beforeunload', () => {
                try { adminSocket.disconnect(); } catch (_) {}
            });
        }
    try { window.toggleAutoPrint = toggleAutoPrint;
    window.toggleAutoPrintReceipt = toggleAutoPrintReceipt; } catch(err) {}
    // ===== 共享上下文（供后续拆分模块使用）=====
    try {
      Object.assign(window.SLF.admin, {
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
        setCurrencies: (v) => currenciesCache = v,
        dualCurrencyEnabled: () => dualCurrencyEnabled,
        secondaryCurrencyCode: () => secondaryCurrencyCode,
        defaultCurrencyObj: () => defaultCurrencyObj,
        setDualCurrency: (v) => dualCurrencyEnabled = v,
        setSecondaryCurrencyCode: (v) => secondaryCurrencyCode = v,
        setDefaultCurrencyObj: (v) => defaultCurrencyObj = v,
        buildSessionLabels,
        showConfirm,
        showPasswordModal
      });
      window.hideConfirm = hideConfirm;
      window.executeConfirm = executeConfirm;
      window.hidePasswordModal = hidePasswordModal;
      window.executePasswordModal = executePasswordModal;
      window.switchMenuTab = switchMenuTab;
      window.loadReportSummary = loadReportSummary;
      window.applyAdminLanguage = applyAdminLanguage;
      window.loadAdminLanguage = loadAdminLanguage;
    } catch(err) {}
})();
