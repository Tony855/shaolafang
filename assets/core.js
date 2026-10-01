/* ============================================================
   FoodFlow 点餐系统 - 核心库 (core.js)
   统一 SLF 命名空间，所有页面只调用 SLF.*
   模块：i18n / api / audio / store / log / page / utils（DOM/UI 见 modules/ui.js）
   ============================================================ */

(function (global) {
  'use strict';

  /* ===== 全局配置 ===== */
  const CONFIG = {
    API_BASE: '/api',
    DEFAULT_LANG: 'zh',
    VERSION: '20260918',
    STORAGE_KEYS: {
      lang: 'lang',
      adminToken: 'adminToken',
      waiterToken: 'waiterToken',
      kitchenToken: 'kitchenToken',
      superToken: 'superToken',
      cashierToken: 'cashierToken',
      storeId: 'storeId',
    },
  };

  /* ============================================================
     SLF.log - 统一日志模块
     ============================================================ */
  const log = {
    _enabled: true,

    enable() { this._enabled = true; },
    disable() { this._enabled = false; },

    _format(level, args) {
      const time = new Date().toISOString().substr(11, 8);
      // 注意：必须返回数组（原代码用逗号运算符，导致时间戳被丢弃）
      return [`[${time}] [SLF.${level}]`, ...args];
    },

    info(...args) {
      if (!this._enabled) return;
      console.log(...this._format('info', args));
    },

    warn(...args) {
      if (!this._enabled) return;
      console.warn(...this._format('warn', args));
    },

    error(...args) {
      if (!this._enabled) return;
      console.error(...this._format('error', args));
    },

    debug(...args) {
      if (!this._enabled) return;
      console.debug(...this._format('debug', args));
    },
  };

  /* ============================================================
     SLF.store - 统一本地存储模块（命名空间隔离）
     ============================================================ */
  const store = {
    _namespace: 'foodflow_',

    _key(key) {
      return this._namespace + key;
    },

    get(key, defaultValue = null) {
      try {
        const value = localStorage.getItem(this._key(key));
        if (value === null) return defaultValue;
        try {
          return JSON.parse(value);
        } catch (e) {
          return value;
        }
      } catch (e) {
        log.warn('store.get 失败:', key, e);
        return defaultValue;
      }
    },

    set(key, value) {
      try {
        // 统一 JSON 序列化，确保字符串、数字、布尔值等类型都能正确还原
        const strValue = JSON.stringify(value);
        localStorage.setItem(this._key(key), strValue);
        return true;
      } catch (e) {
        log.error('store.set 失败:', key, e);
        return false;
      }
    },

    remove(key) {
      try {
        localStorage.removeItem(this._key(key));
        return true;
      } catch (e) {
        log.warn('store.remove 失败:', key, e);
        return false;
      }
    },

    has(key) {
      return localStorage.getItem(this._key(key)) !== null;
    },

    clear() {
      try {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(this._namespace)) {
            keys.push(key);
          }
        }
        keys.forEach(k => localStorage.removeItem(k));
        return true;
      } catch (e) {
        log.error('store.clear 失败:', e);
        return false;
      }
    },

    /* 直接访问原始 localStorage（兼容旧代码） */
    rawGet(key, defaultValue = null) {
      try {
        const value = localStorage.getItem(key);
        return value === null ? defaultValue : value;
      } catch (e) {
        return defaultValue;
      }
    },

    rawSet(key, value) {
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (e) {
        return false;
      }
    },

    rawRemove(key) {
      try {
        localStorage.removeItem(key);
        return true;
      } catch (e) {
        return false;
      }
    },

    /* 直接访问原始 sessionStorage（用于 adminToken 等需要关闭浏览器即失效的场景） */
    rawGetSession(key, defaultValue = null) {
      try {
        const value = sessionStorage.getItem(key);
        return value === null ? defaultValue : value;
      } catch (e) {
        return defaultValue;
      }
    },

    rawSetSession(key, value) {
      try {
        sessionStorage.setItem(key, value);
        return true;
      } catch (e) {
        return false;
      }
    },

    rawRemoveSession(key) {
      try {
        sessionStorage.removeItem(key);
        return true;
      } catch (e) {
        return false;
      }
    },
  };

  /* ============================================================
     SLF.i18n - 统一国际化模块
     ============================================================ */
  const i18n = {
    lang: CONFIG.DEFAULT_LANG,
    dicts: {},
    _listeners: [],
    _loaded: false,

    /* 初始化：加载语言字典 */
    async init(lang, customDict) {
      this.lang = lang || CONFIG.DEFAULT_LANG;
      store.rawSet(CONFIG.STORAGE_KEYS.lang, this.lang);

      /* 优先使用 languages.min.js 中的内置字典 */
      if (global.LANGUAGES && global.LANGUAGES[this.lang]) {
        this.dicts[this.lang] = { ...global.LANGUAGES[this.lang] };
        this._loaded = true;
        log.info('i18n: 使用内置字典', this.lang);
      } else {
        /* 兜底：从 API 加载 */
        await this.loadLanguage(this.lang);
      }

      /* 合并自定义字典（如 ADMIN_LABELS） */
      if (customDict && customDict[this.lang]) {
        this.dicts[this.lang] = { ...(this.dicts[this.lang] || {}), ...customDict[this.lang] };
        log.info('i18n: 合并自定义字典', this.lang);
      }

      return this;
    },

    /* 从 API 加载语言字典 */
    async loadLanguage(lang) {
      try {
        const cached = store.rawGet('i18n_' + lang);
        if (cached) {
          try {
            this.dicts[lang] = JSON.parse(cached);
            log.info('i18n: 使用缓存字典', lang);
            return true;
          } catch (e) {}
        }

        const res = await fetch(`/api/i18n/${lang}?v=${CONFIG.VERSION}`);
        if (res.ok) {
          const data = await res.json();
          this.dicts[lang] = data;
          store.rawSet('i18n_' + lang, JSON.stringify(data));
          log.info('i18n: 从 API 加载字典', lang);
          return true;
        }
      } catch (e) {
        log.warn('i18n: 加载语言失败', lang, e);
      }
      return false;
    },

    /* 翻译函数 */
    t(key, params) {
      let text = key;

      /* 1. 先查当前语言字典 */
      if (this.dicts[this.lang] && this.dicts[this.lang][key] !== undefined) {
        text = this.dicts[this.lang][key];
      }
      /* 2. 再查全局 LANGUAGES */
      else if (global.LANGUAGES && global.LANGUAGES[this.lang] && global.LANGUAGES[this.lang][key] !== undefined) {
        text = global.LANGUAGES[this.lang][key];
      }
      /* 3. 最后查中文兜底 */
      else if (this.dicts.zh && this.dicts.zh[key] !== undefined) {
        text = this.dicts.zh[key];
      } else if (global.LANGUAGES && global.LANGUAGES.zh && global.LANGUAGES.zh[key] !== undefined) {
        text = global.LANGUAGES.zh[key];
      }

      /* 参数替换 */
      if (params && typeof params === 'object') {
        Object.keys(params).forEach(k => {
          text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]);
        });
      }

      return text;
    },

    /* 切换语言 */
    async setLang(lang) {
      if (this.lang === lang) return;
      this.lang = lang;
      store.rawSet(CONFIG.STORAGE_KEYS.lang, lang);

      if (!this.dicts[lang] && !(global.LANGUAGES && global.LANGUAGES[lang])) {
        await this.loadLanguage(lang);
      }

      /* 通知监听器 */
      this._listeners.forEach(fn => {
        try { fn(lang); } catch (e) { log.error('i18n onChange 监听器失败:', e); }
      });
    },

    /* 注册语言变化监听器 */
    onChange(fn) {
      if (typeof fn === 'function') {
        this._listeners.push(fn);
      }
    },

    /* 获取当前语言 */
    getLang() {
      return this.lang;
    },

    /* 检查某个 key 是否有翻译 */
    has(key) {
      return (this.dicts[this.lang] && this.dicts[this.lang][key] !== undefined) ||
             (global.LANGUAGES && global.LANGUAGES[this.lang] && global.LANGUAGES[this.lang][key] !== undefined);
    },
  };

  /* ============================================================
     SLF.api - 统一 API 请求模块
     ============================================================ */
  const api = {
    baseUrl: CONFIG.API_BASE,

    /* 获取认证头 */
    _getAuthHeaders() {
      const headers = {};
    
      // 当前页面路径判断
      const path = (typeof window !== 'undefined' && window.location)
        ? window.location.pathname
        : '';
      const isSuperPage = path.startsWith('/super');
      const isCustomerPage = path === '/' || path.endsWith('/index.html');

      const adminToken   = sessionStorage.getItem(CONFIG.STORAGE_KEYS.adminToken);
      const superToken   = store.rawGet(CONFIG.STORAGE_KEYS.superToken);
      const waiterToken  = store.rawGet(CONFIG.STORAGE_KEYS.waiterToken) ||
                           store.rawGet(CONFIG.STORAGE_KEYS.kitchenToken);
      const cashierToken = store.rawGet(CONFIG.STORAGE_KEYS.cashierToken);

      // 客户端页面不带任何员工认证头，避免后端误判为员工下单
      if (!isCustomerPage) {
        // /super 页面：超管 token 直接放 Authorization，避免与 adminToken 冲突
        if (isSuperPage && superToken) {
          headers['Authorization'] = 'Bearer ' + superToken;
        } else {
          if (adminToken)  headers['Authorization']   = 'Bearer ' + adminToken;
          if (superToken)  headers['X-Super-Token']   = superToken;
        }
        if (waiterToken)  headers['X-Waiter-Token']   = waiterToken;
        if (cashierToken) headers['X-Cashier-Token']  = cashierToken;
      }
    
      const storeId = store.rawGet(CONFIG.STORAGE_KEYS.storeId);
      if (storeId) headers['X-Store-Id'] = storeId;
    
      return headers;
    },

    /* 核心请求方法 */
    async _request(method, path, options = {}) {
      const url = path.startsWith('http') ? path : this.baseUrl + path;
      const headers = {
        'Content-Type': 'application/json',
        ...this._getAuthHeaders(),
        ...(options.headers || {}),
      };

      if (options.body instanceof FormData) {
        delete headers['Content-Type'];
      }

      const config = {
        method,
        headers,
        credentials: 'same-origin',
      };

      if (options.body !== undefined && options.body !== null) {
        config.body = options.body instanceof FormData 
          ? options.body 
          : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }

      try {
        const res = await fetch(url, config);
        const contentType = res.headers.get('content-type') || '';
        let data;
        if (contentType.includes('application/json')) {
          data = await res.json().catch(() => ({}));
        } else {
          data = await res.text();
        }

        if (!res.ok) {
          const rawMsg = (data && data.error) || `请求失败 (${res.status})`;
          // 用 __err__前缀 查找翻译，找不到用原文
          let translated = rawMsg;
          try {
            if (i18n && typeof i18n.t === 'function') {
              const v = i18n.t('__err__' + rawMsg);
              if (v && v !== '__err__' + rawMsg) translated = v;
            }
          } catch (_) {}
          const error = new Error(translated);
          error.rawMessage = rawMsg;
          error.status = res.status;
          error.data = data;
          // 401 统一跳转登录页
          if (res.status === 401) {
            const page = location.pathname;
            if (!page.startsWith('/login')) {
              // 先清除 token
              try {
                localStorage.removeItem('adminToken');
                localStorage.removeItem('cashierToken');
                localStorage.removeItem('waiterToken');
                localStorage.removeItem('kitchenToken');
                localStorage.removeItem('superToken');
                sessionStorage.removeItem('adminToken');
              } catch(e) {}

              const type = page.replace(/^\//, '').split('/')[0];
              // kitchen / super 页面自带登录界面，停留在本页，由页面自行处理
              if (type !== 'kitchen' && type !== 'super') {
                const redirect = type && !['admin', 'cashier', 'waiter'].includes(type)
                  ? '/login'
                  : '/login?type=' + type;
                location.replace(redirect);
              }
            }
          }
          throw error;
        }
        return data;
      } catch (err) {
        if (err.name === 'TypeError' || !err.status) {
          throw new Error('网络连接失败，请检查后端服务');
        }
        throw err;
      }
    },

    // 兼容别名：admin.js 里 api(path, {method, body}) 走这里
    request(path, options = {}) {
      const method = (options.method || 'GET').toUpperCase();
      return this._request(method, path, options);
    },

    get(path, options) { return this._request('GET', path, options); },
    post(path, body, options) { return this._request('POST', path, { ...options, body }); },
    put(path, body, options) { return this._request('PUT', path, { ...options, body }); },
    del(path, options) { return this._request('DELETE', path, options); },
    patch(path, body, options) { return this._request('PATCH', path, { ...options, body }); },

    /* 上传文件 */
    upload(path, formData, options = {}) {
      return this._request('POST', path, { ...options, body: formData });
    },
  };

  /* ============================================================
     SLF.audio - 统一音频模块（防御式）
     ============================================================ */
  const audio = {
    _enabled: true,
    _ctx: null,
    _unlocked: false,

    /* 解锁音频（需要用户交互后调用） */
    unlock() {
      if (this._unlocked) return;
      try {
        const AudioContext = global.AudioContext || global.webkitAudioContext;
        if (AudioContext) {
          this._ctx = new AudioContext();
          if (this._ctx.state === 'suspended') {
            this._ctx.resume();
          }
          this._unlocked = true;
        }
      } catch (e) {
        log.warn('audio.unlock 失败:', e);
      }
    },

    /* 设置是否启用 */
    setEnabled(enabled) {
      this._enabled = !!enabled;
    },

    /* 是否启用 */
    isEnabled() {
      return this._enabled;
    },

    /* 新订单提示音 */
    playNewOrderChime() {
      if (!this._enabled) return;
      this.unlock();
      if (!this._ctx) return;
      try {
        const now = this._ctx.currentTime;
        const notes = [[0, 880], [0.15, 1100], [0.3, 1320]];
        notes.forEach(([t, freq]) => {
          const osc = this._ctx.createOscillator();
          const gain = this._ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, now + t);
          gain.gain.exponentialRampToValueAtTime(0.3, now + t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.3);
          osc.connect(gain).connect(this._ctx.destination);
          osc.start(now + t);
          osc.stop(now + t + 0.35);
        });
      } catch (e) {
        log.warn('audio.playNewOrderChime 失败:', e);
      }
    },

    /* 催单提示音 */
    playUrgeChime() {
      if (!this._enabled) return;
      this.unlock();
      if (!this._ctx) return;
      try {
        const now = this._ctx.currentTime;
        [[0, 1000], [0.15, 1400], [0.30, 1000], [0.45, 1400]].forEach(([t, freq]) => {
          const osc = this._ctx.createOscillator();
          const gain = this._ctx.createGain();
          osc.type = 'square';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, now + t);
          gain.gain.exponentialRampToValueAtTime(0.2, now + t + 0.01);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.12);
          osc.connect(gain).connect(this._ctx.destination);
          osc.start(now + t);
          osc.stop(now + t + 0.15);
        });
      } catch (e) {
        log.warn('audio.playUrgeChime 失败:', e);
      }
    },

    /* 呼叫服务员提示音 */
    playCallChime() {
      if (!this._enabled) return;
      this.unlock();
      if (!this._ctx) return;
      try {
        const now = this._ctx.currentTime;
        [[0, 1200], [0.2, 1600], [0.4, 1200]].forEach(([t, freq]) => {
          const osc = this._ctx.createOscillator();
          const gain = this._ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, now + t);
          gain.gain.exponentialRampToValueAtTime(0.3, now + t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.3);
          osc.connect(gain).connect(this._ctx.destination);
          osc.start(now + t);
          osc.stop(now + t + 0.35);
        });
      } catch (e) {
        log.warn('audio.playCallChime 失败:', e);
      }
    },
  };

  /* ============================================================
     SLF.utils - 通用工具模块
     ============================================================ */
  const utils = {
    /* 格式化时间 */
    formatTime(date) {
      if (!date) return '';
      const d = new Date(date);
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    },

    /* 格式化日期时间 */
    formatDateTime(date) {
      if (!date) return '';
      const d = new Date(date);
      return d.toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      });
    },

    /* 格式化日期 */
    formatDate(date) {
      if (!date) return '';
      const d = new Date(date);
      return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
    },

    /* 格式化金额 */
    formatMoney(amount, decimals = 2) {
      const num = Number(amount || 0);
      return num.toFixed(decimals);
    },

    /* 格式化带符号金额 */
    formatCurrency(amount, symbol = '¥', decimals = 2) {
      return symbol + this.formatMoney(amount, decimals);
    },

    /* 防抖 */
    debounce(fn, delay = 300) {
      let timer = null;
      return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
      };
    },

    /* 节流 */
    throttle(fn, delay = 300) {
      let last = 0;
      return function (...args) {
        const now = Date.now();
        if (now - last >= delay) {
          last = now;
          fn.apply(this, args);
        }
      };
    },

    /* 深拷贝 */
    deepClone(obj) {
      if (obj === null || typeof obj !== 'object') return obj;
      if (obj instanceof Date) return new Date(obj);
      if (obj instanceof Array) return obj.map(item => this.deepClone(item));
      const cloned = {};
      Object.keys(obj).forEach(key => {
        cloned[key] = this.deepClone(obj[key]);
      });
      return cloned;
    },

    /* 生成唯一 ID */
    uuid() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    },

    /* 睡眠 */
    sleep(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    /* 重试 */
    async retry(fn, retries = 3, delay = 1000) {
      try {
        return await fn();
      } catch (e) {
        if (retries <= 0) throw e;
        await this.sleep(delay);
        return this.retry(fn, retries - 1, delay);
      }
    },

    /* HTML 转义 */
    esc(str) {
      return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    },
  };

  /* ============================================================
     SLF.page - 统一页面生命周期模块
     ============================================================ */
  const page = {
    _booted: false,
    _cleanupFns: [],

    /* 页面启动 */
    async boot(options = {}) {
      if (this._booted) return;
      this._booted = true;

      log.info('page.boot: 页面启动');

      /* 1. 初始化语言 */
      const savedLang = store.rawGet(CONFIG.STORAGE_KEYS.lang) ||
                        store.rawGet('adminLang') ||
                        store.rawGet('waiterLang') ||
                        store.rawGet('kitchenLang') ||
                        store.rawGet('superLang') ||
                        CONFIG.DEFAULT_LANG;
      await i18n.init(savedLang);

      /* 2. 解锁音频 */
      document.addEventListener('click', () => audio.unlock(), { once: true });

      /* 3. 执行自定义启动逻辑 */
      if (typeof options.onReady === 'function') {
        try {
          await options.onReady();
        } catch (e) {
          log.error('page.boot onReady 失败:', e);
        }
      }

      /* 4. 注册清理函数 */
      if (typeof options.onCleanup === 'function') {
        this._cleanupFns.push(options.onCleanup);
      }

      /* 5. 页面卸载时清理（先移除旧的监听器，防止重复注册） */
      if (this._beforeUnloadHandler) {
        global.removeEventListener('beforeunload', this._beforeUnloadHandler);
      }
      this._beforeUnloadHandler = () => this.cleanup();
      global.addEventListener('beforeunload', this._beforeUnloadHandler);

      log.info('page.boot: 页面启动完成');
    },

    /* 页面就绪（DOM 加载完成） */
    ready(fn) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', fn);
      } else {
        fn();
      }
    },

    /* 页面清理 */
    cleanup() {
      log.info('page.cleanup: 页面清理');
      this._cleanupFns.forEach(fn => {
        try { fn(); } catch (e) { log.error('page.cleanup 失败:', e); }
      });
      this._cleanupFns = [];
      this._booted = false;
    },

    /* 注册清理函数 */
    onCleanup(fn) {
      if (typeof fn === 'function') {
        this._cleanupFns.push(fn);
      }
    },

    /* 刷新页面 */
    reload() {
      global.location.reload();
    },

    /* 跳转页面 */
    redirect(url) {
      global.location.href = url;
    },
  };

  /* ============================================================
     导出到全局 SLF 对象
     ============================================================ */
  global.SLF = {
    ...(global.SLF || {}),
    CONFIG,
    i18n,
    api,
    audio,
    store,
    log,
    page,
    utils,
  };

  log.info('SLF core.js 加载完成，版本:', CONFIG.VERSION);

  /* ===== 统一翻译函数（带 fallback + 防御）===== */
  function t(key, params, fallback) {
    try {
      if (!i18n || typeof i18n.t !== 'function') {
        return fallback !== undefined ? fallback : key;
      }
      const v = i18n.t(key, params);
      if (v === undefined || v === null || v === key) {
        return fallback !== undefined ? fallback : key;
      }
      return v;
    } catch (e) {
      return fallback !== undefined ? fallback : key;
    }
  }

  /* 挂到 SLF 与全局 */
  global.SLF.t = t;
  global.t = t;
  global.esc = utils.esc;

})(window);
