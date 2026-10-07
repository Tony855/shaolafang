/* Extracted from login.html on 2026-09-28 (no IIFE, exposes globals for inline onclick) */
const $ = s => document.querySelector(s);
    const el = id => document.getElementById(id);

    // ---- 初始化语言 ----
    const SUPPORTED_LANGS = ['zh', 'en', 'vi', 'th', 'km'];
    let lang = SLF.store.rawGet('lang')
      || SLF.store.rawGet('adminLang')
      || SLF.store.rawGet('waiterLang')
      || SLF.store.rawGet('cashierLang')
      || SLF.store.rawGet('kitchenLang')
      || 'zh';
    if (!SUPPORTED_LANGS.includes(lang)) lang = 'zh';

    // 初始化 i18n（同步）
    try { SLF.i18n.init(lang); } catch (e) { console.warn('i18n.init failed:', e); }

    // ---- t(key, params, fallback) ----
    // ---- 登录类型 ----
    // 优先级：URL 参数 > 上次保存 > 默认 admin
    let loginType = 'admin';
    const urlParams = new URLSearchParams(window.location.search);
    const typeParam = urlParams.get('type');
    const savedType = SLF.store.rawGet('preferredLoginType');

    if (typeParam && ['admin', 'waiter', 'cashier'].includes(typeParam)) {
      loginType = typeParam;
    } else if (savedType && ['admin', 'waiter', 'cashier'].includes(savedType)) {
      loginType = savedType;
    }

    // ---- 应用语言 & 界面状态 ----
    function setText(id, txt) { const e = el(id); if (e) e.textContent = txt; }
    function setPlaceholder(id, txt) { const e = el(id); if (e) e.placeholder = txt; }

    function apply() {
      try {
        document.title = t('login', null, '登录') + ' - ' + t('brandName', null, 'FoodFlow');

        setText('brandTitle', t('brandName', null, 'FoodFlow'));

        const langSelect = el('langSelect');
        if (langSelect) langSelect.value = lang;

        const loginTypeSel = el('loginType');
        if (loginTypeSel) loginTypeSel.value = loginType;

        setText('loginTypeLabel', t('loginType', null, '登录类型'));

        // 只改 option textContent（选择器加 null 保护）
        const optAdmin = document.querySelector('#loginType option[value="admin"]');
        const optWaiter = document.querySelector('#loginType option[value="waiter"]');
        const optCashier = document.querySelector('#loginType option[value="cashier"]');
        if (optAdmin) optAdmin.textContent = '👔 ' + t('admin', null, '管理员');
        if (optWaiter) optWaiter.textContent = '🧑‍🍳 ' + t('waiter', null, '服务员');
        if (optCashier) optCashier.textContent = '💰 ' + (t('cashier', null, '收银员'));

        // 根据类型设置标题和 placeholder
        if (loginType === 'admin') {
          setText('loginTitle', t('adminLogin', null, '管理员登录'));
          setText('loginDesc', t('adminLoginDesc', null, '请输入管理员用户名和密码'));
          setPlaceholder('username', t('adminUsername', null, '管理员用户名'));
          setPlaceholder('password', t('adminPassword', null, '管理员密码'));
        } else if (loginType === 'cashier') {
          setText('loginTitle', t('cashierLogin', null, '收银员登录'));
          setText('loginDesc', t('cashierLoginDesc', null, '请输入收银员账号和密码'));
          setPlaceholder('username', t('cashierUsername', null, '收银员账号'));
          setPlaceholder('password', t('cashierPassword', null, '密码'));
        } else {
          setText('loginTitle', t('waiterLogin', null, '服务员登录'));
          setText('loginDesc', t('waiterLoginDesc', null, '请输入服务员账号和密码'));
          setPlaceholder('username', t('username', null, '账号'));
          setPlaceholder('password', t('password', null, '密码'));
        }

        const loginBtn = el('loginBtn');
        if (loginBtn && !loginBtn.disabled) loginBtn.textContent = t('login', null, '登录');
      } catch (e) {
        console.warn('apply() failed:', e);
      }
    }

    // ---- 动态加载语言包（切换语言时）----
    async function loadLangAndApply(nextLang) {
      try {
        if (nextLang !== 'zh' && SLF.i18n && typeof SLF.i18n.loadLanguage === 'function') {
          await SLF.i18n.loadLanguage(nextLang);
        }
      } catch (e) {
        console.warn('loadLanguage failed:', e);
        // 加载失败回退到中文
        nextLang = 'zh';
      }
      // 兼容两种 setLang 写法
      try {
        if (SLF.i18n && typeof SLF.i18n.setLang === 'function') {
          SLF.i18n.setLang(nextLang);
        } else if (SLF.i18n) {
          SLF.i18n.lang = nextLang;
        }
      } catch (e) {
        console.warn('setLang failed:', e);
      }
      apply();
    }

    // ---- 首次初始化 ----
    (async () => {
      await loadLangAndApply(lang);
    })();

    // ---- 语言切换 ----
    const langSelectEl = el('langSelect');
    if (langSelectEl) {
      langSelectEl.addEventListener('change', async function () {
        lang = this.value;
        if (!SUPPORTED_LANGS.includes(lang)) lang = 'zh';
        // 同步所有角色的语言设置
        SLF.store.rawSet('lang', lang);
        SLF.store.rawSet('adminLang', lang);
        SLF.store.rawSet('waiterLang', lang);
        SLF.store.rawSet('kitchenLang', lang);
        SLF.store.rawSet('cashierLang', lang);
        await loadLangAndApply(lang);
      });
    }

    // ---- 登录类型切换 ----
    const loginTypeEl = el('loginType');
    if (loginTypeEl) {
      loginTypeEl.addEventListener('change', function () {
        loginType = this.value;
        SLF.store.rawSet('preferredLoginType', loginType);
        apply();
        // 焦点跳转到用户名
        const u = el('username');
        if (u) u.focus();
      });
    }

    // ---- 错误消息翻译 ----
    function translateError(msg) {
      if (!msg) return t('loginError', null, '登录失败，请重试');
      const text = String(msg);
      if (text.includes('用户名或密码错误') || text.includes('用户名不存在') || text.includes('密码错误')
          || text.includes('Invalid username') || text.includes('does not exist')) {
        return t('invalidCredentials', null, '用户名或密码错误');
      }
      if (text.includes('账号已被禁用') || text.includes('已禁用') || text.includes('disabled')) {
        return t('accountDisabled', null, '账号已被禁用');
      }
      if (text.includes('请输入') || text.includes('Please enter')) {
        return t('pleaseEnterCredentials', null, '请输入用户名和密码');
      }
      if (text.includes('登录失败次数过多') || text.includes('Too many')) {
        return text; // 保留原文，包含剩余分钟数
      }
      return text;
    }

    // ---- 错误弹窗 ----
    function showErrorModal(message, title) {
      setText('errorModalTitle', title || t('loginFailed', null, '登录失败'));
      setText('errorModalMessage', message || t('loginError', null, '登录失败，请重试'));
      setText('errorModalBtn', t('confirm', null, '确定'));
      const modal = el('errorModal');
      if (modal) modal.classList.add('open');
    }
    function hideErrorModal() {
      const modal = el('errorModal');
      if (modal) modal.classList.remove('open');
    }
    window.hideErrorModal = hideErrorModal;

    const errorModalEl = el('errorModal');
    if (errorModalEl) {
      errorModalEl.addEventListener('click', function (e) {
        if (e.target === this) hideErrorModal();
      });
    }

    // ---- 登录按钮（带防抖 + loading）----
    let isSubmitting = false;

    async function doLogin() {
      if (isSubmitting) return;

      const password = el('password').value.trim();
      if (!password) { showErrorModal(t('enterPassword', null, '请输入密码')); return; }

      const username = el('username').value.trim();
      if (!username) { showErrorModal(t('enterUsername', null, '请输入用户名')); return; }

      isSubmitting = true;
      const loginBtn = el('loginBtn');
      const originalText = loginBtn ? loginBtn.textContent : '';
      if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.textContent = t('loggingIn', null, '登录中...');
      }

      try {
        if (loginType === 'admin') {
          const data = await SLF.api.post('/admin/login', { username, password });
          SLF.store.rawSetSession('adminToken', data.token);
          SLF.store.rawSetSession('adminMerchantId', data.merchantId);
          SLF.store.rawSetSession('adminMerchantName', data.merchantName);
          SLF.store.rawSetSession('adminId', data.adminId || '');
          SLF.store.rawSetSession('adminIsPrimary', data.isPrimary ? '1' : '0');
          SLF.store.rawSetSession('adminPermissions', JSON.stringify(data.permissions || {}));
          // ★ 清掉旧商户残留的 storeId，避免跨商户登录带错 X-Store-Id
          SLF.store.rawRemove('storeId');
          SLF.store.rawRemove('waiterStoreId');
          SLF.store.rawRemove('cashierStoreId');
          SLF.store.rawRemoveSession('adminStoreId');
          if (data.storeId) {
            SLF.store.rawSet('storeId', String(data.storeId));
            SLF.store.rawSetSession('adminStoreId', String(data.storeId));
          }
          window.location.href = '/admin';
          return;
        } else if (loginType === 'cashier') {
          const data = await SLF.api.post('/cashier/login', { username, password });
          // ★ 清掉其它角色的 storeId，避免污染
          SLF.store.rawRemove('storeId');
          SLF.store.rawRemove('waiterStoreId');
          SLF.store.rawRemoveSession('adminStoreId');
          SLF.store.rawSet('cashierToken', data.token);
          SLF.store.rawSet('cashierStoreId', String(data.storeId || 1));
          SLF.store.rawSet('storeId', String(data.storeId || 1));
          SLF.store.rawSet('cashierInfo', JSON.stringify({ ...data.cashier, storeName: data.storeName }));
          window.location.href = '/cashier';
          return;
        } else {
          const data = await SLF.api.post('/waiter/login', { username, password });
          // ★ 清掉其它角色的 storeId，避免污染
          SLF.store.rawRemove('storeId');
          SLF.store.rawRemove('cashierStoreId');
          SLF.store.rawRemoveSession('adminStoreId');
          SLF.store.rawSet('waiterToken', data.token);
          SLF.store.rawSet('waiterStoreId', String(data.storeId || 1));
          SLF.store.rawSet('storeId', String(data.storeId || 1));
          window.location.href = '/waiter';
          return;
        }
      } catch (e) {
        showErrorModal(translateError(e && e.message));
        // 恢复按钮状态（只有失败才恢复；成功时页面即将跳转）
        isSubmitting = false;
        if (loginBtn) {
          loginBtn.disabled = false;
          loginBtn.textContent = originalText || t('login', null, '登录');
        }
      }
    }
    window.doLogin = doLogin;

    const loginBtnEl = el('loginBtn');
    if (loginBtnEl) loginBtnEl.addEventListener('click', doLogin);

    // ---- 键盘 Enter ----
    const passwordEl = el('password');
    if (passwordEl) {
      passwordEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); doLogin(); }
      });
    }
    const usernameEl = el('username');
    if (usernameEl) {
      usernameEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          // 焦点跳转到密码框（而不是直接登录）
          if (passwordEl) passwordEl.focus();
        }
      });
    }
