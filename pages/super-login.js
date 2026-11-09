'use strict';

(() => {
  const supported = ['zh', 'en', 'vi', 'th', 'km'];
  const form = document.getElementById('superLoginForm');
  const usernameInput = document.getElementById('loginUsername');
  const passwordInput = document.getElementById('loginPassword');
  const loginButton = document.getElementById('loginBtn');
  const errorBox = document.getElementById('loginError');
  const languageSelect = document.getElementById('loginLangSelect');
  let submitting = false;
  let lang = SLF.store.rawGet('superLang') || SLF.store.rawGet('lang') || 'zh';
  if (!supported.includes(lang)) lang = 'zh';

  function applyLanguage() {
    document.documentElement.lang = lang === 'km' ? 'km' : lang;
    languageSelect.value = lang;
    document.querySelectorAll('[data-i18n]').forEach(element => {
      const key = element.getAttribute('data-i18n');
      const translated = SLF.t(key, null, element.textContent);
      if (translated && translated !== key) element.textContent = translated;
    });
    document.title = SLF.t('superAdmin', null, '超级管理员') + ' · FoodFlow';
  }

  async function changeLanguage(next) {
    lang = supported.includes(next) ? next : 'zh';
    try {
      if (lang !== 'zh' && SLF.i18n.loadLanguage) await SLF.i18n.loadLanguage(lang);
      await SLF.i18n.setLang(lang);
    } catch (_) {
      lang = 'zh';
      try { await SLF.i18n.setLang('zh'); } catch (_) {}
    }
    SLF.store.rawSet('superLang', lang);
    SLF.store.rawSet('lang', lang);
    applyLanguage();
  }

  languageSelect.addEventListener('change', () => changeLanguage(languageSelect.value));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    errorBox.textContent = '';
    if (!username || !password) {
      errorBox.textContent = SLF.t('pleaseEnterCredentials', null, '请输入用户名和密码');
      return;
    }
    submitting = true;
    loginButton.disabled = true;
    loginButton.textContent = SLF.t('loggingIn', null, '登录中…');
    try {
      const result = await SLF.api.post('/super/login', { username, password });
      if (!result || result.success !== true || typeof result.token !== 'string' || !result.token) {
        throw new Error((result && result.error) || SLF.t('loginFailed', null, '登录失败，请重试'));
      }
      SLF.store.rawSet('superToken', result.token);
      SLF.store.rawSet('superAdmin', JSON.stringify(result.admin || {}));
      window.location.replace('/super');
    } catch (error) {
      errorBox.textContent = error && error.message
        ? error.message
        : SLF.t('loginFailed', null, '登录失败，请重试');
      passwordInput.value = '';
      passwordInput.focus();
    } finally {
      submitting = false;
      loginButton.disabled = false;
      loginButton.textContent = SLF.t('login', null, '登录');
    }
  });

  SLF.i18n.init(lang);
  changeLanguage(lang);
  if (SLF.store.rawGet('superToken')) window.location.replace('/super');
})();
