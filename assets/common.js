/* ============================================================
   烧腊坊点餐系统 - 统一前端工具库 (Common JS)
   所有页面共享此文件，提供 API 客户端、i18n、工具函数
   ============================================================ */

(function (global) {
  'use strict';

  // ---------- 配置 ----------
  const CONFIG = {
    API_BASE: '/api',
    DEFAULT_LANG: 'zh',
    STORAGE_KEYS: {
      adminKey: 'adminKey',
      adminLang: 'adminLang',
      waiterToken: 'waiterToken',
      waiterLang: 'waiterLang',
      kitchenToken: 'kitchenToken',
      kitchenLang: 'kitchenLang',
      customerLang: 'customerLang',
      storeId: 'storeId',
    },
  };

  // ---------- 统一 API 客户端 ----------
  class ApiClient {
    constructor(baseUrl) {
      this.baseUrl = baseUrl || CONFIG.API_BASE;
      this.defaultHeaders = { 'Content-Type': 'application/json' };
    }

    _getAuthHeaders() {
      const headers = {};
      const adminKey = sessionStorage.getItem(CONFIG.STORAGE_KEYS.adminKey);
      const waiterToken =
        localStorage.getItem(CONFIG.STORAGE_KEYS.waiterToken) ||
        localStorage.getItem(CONFIG.STORAGE_KEYS.kitchenToken);
      if (adminKey) headers['X-Admin-Key'] = adminKey;
      if (waiterToken) headers['X-Waiter-Token'] = waiterToken;
      const storeId = localStorage.getItem(CONFIG.STORAGE_KEYS.storeId);
      if (storeId) headers['X-Store-Id'] = storeId;
      return headers;
    }

    async _request(method, path, options = {}) {
      const url = path.startsWith('http') ? path : this.baseUrl + path;
      const headers = {
        ...this.defaultHeaders,
        ...this._getAuthHeaders(),
        ...(options.headers || {}),
      };

      // FormData 时移除 Content-Type，让浏览器自动设置 boundary
      if (options.body instanceof FormData) {
        delete headers['Content-Type'];
      }

      const config = {
        method,
        headers,
        credentials: 'same-origin',
      };

      if (options.body !== undefined) {
        config.body =
          options.body instanceof FormData
            ? options.body
            : JSON.stringify(options.body);
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
          const error = new Error(
            (data && data.error) || `请求失败 (${res.status})`
          );
          error.status = res.status;
          error.data = data;
          throw error;
        }
        return data;
      } catch (err) {
        if (err.name === 'TypeError' || !err.status) {
          throw new Error('网络连接失败，请检查后端服务');
        }
        throw err;
      }
    }

    get(path, params) {
      if (params) {
        const qs = new URLSearchParams(params).toString();
        if (qs) path += (path.includes('?') ? '&' : '?') + qs;
      }
      return this._request('GET', path);
    }

    post(path, body, options) {
      return this._request('POST', path, { body, ...options });
    }

    put(path, body, options) {
      return this._request('PUT', path, { body, ...options });
    }

    del(path, body) {
      return this._request('DELETE', path, { body });
    }

    upload(path, formData) {
      return this._request('POST', path, { body: formData });
    }
  }

  const api = new ApiClient();

  // ---------- 统一 i18n 翻译系统 ----------
  class I18n {
    constructor() {
      this.lang = CONFIG.DEFAULT_LANG;
      this.dicts = {};
      this.fallbackLang = 'zh';
    }

    init(lang, customDicts) {
      this.lang = lang || CONFIG.DEFAULT_LANG;
      if (customDicts) {
        for (const [code, dict] of Object.entries(customDicts)) {
          this.dicts[code] = { ...(this.dicts[code] || {}), ...dict };
        }
      }
      // 合并全局 LANGUAGES
      if (typeof LANGUAGES !== 'undefined') {
        for (const [code, dict] of Object.entries(LANGUAGES)) {
          this.dicts[code] = { ...(this.dicts[code] || {}), ...dict };
        }
      }
    }

    setLang(lang) {
      this.lang = lang;
    }

    t(key, params) {
      const dict = this.dicts[this.lang] || {};
      const fallback = this.dicts[this.fallbackLang] || {};
      let value = dict[key] ?? fallback[key] ?? key;

      // 支持嵌套 categories 等对象
      if (typeof value === 'object' && value !== null) {
        return value;
      }

      // 支持参数替换 {0}, {1} 或 {name}
      if (params) {
        if (Array.isArray(params)) {
          params.forEach((p, i) => {
            value = String(value).replace(`{${i}}`, p);
          });
        } else {
          for (const [k, v] of Object.entries(params)) {
            value = String(value).replace(`{${k}}`, v);
          }
        }
      }
      return value;
    }

    // 获取分类翻译
    category(name) {
      const cats = this.t('categories');
      if (cats && typeof cats === 'object' && cats[name]) return cats[name];
      return name;
    }

    // 获取当前语言的货币信息
    currency() {
      const dict = this.dicts[this.lang] || this.dicts[this.fallbackLang] || {};
      return {
        symbol: dict.currencySymbol || '¥',
        rate: Number(dict.currencyRate) || 1,
        code: dict.currencyCode || this.lang.toUpperCase(),
      };
    }

    // 格式化价格（基础货币 USD -> 当前语言货币）
    formatPrice(basePrice, baseCurrency) {
      const cur = this.currency();
      const rate = cur.rate || 1;
      const converted = Number(basePrice) * rate;
      // 大额货币（VND/KHR）不显示小数
      const decimals = rate >= 1000 ? 0 : 2;
      return `${cur.symbol}${converted.toFixed(decimals)}`;
    }
  }

  const i18n = new I18n();

  // ---------- 工具函数 ----------
  const utils = {
    // HTML 转义
    esc(str) {
      return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c]));
    },

    // 防抖
    debounce(fn, delay) {
      let timer;
      return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
      };
    },

    // 节流
    throttle(fn, limit) {
      let inThrottle;
      return function (...args) {
        if (!inThrottle) {
          fn.apply(this, args);
          inThrottle = true;
          setTimeout(() => (inThrottle = false), limit);
        }
      };
    },

    // 格式化日期时间
    formatDateTime(isoStr, lang) {
      try {
        const d = new Date(isoStr);
        const localeMap = {
          zh: 'zh-CN',
          en: 'en-US',
          vi: 'vi-VN',
          th: 'th-TH',
          km: 'km-KH',
        };
        return d.toLocaleString(localeMap[lang] || 'zh-CN', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return isoStr;
      }
    },

    // 相对时间
    timeAgo(isoStr) {
      const diff = Date.now() - new Date(isoStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return { text: i18n.t('justNow') || '刚刚', level: 'ok' };
      if (mins < 60)
        return {
          text: `${mins} ${i18n.t('minutesAgo') || '分钟前'}`,
          level: mins >= 15 ? 'danger' : mins >= 8 ? 'warn' : 'ok',
        };
      const hours = Math.floor(mins / 60);
      return {
        text: `${hours} ${i18n.t('hoursAgo') || '小时前'}`,
        level: 'danger',
      };
    },

    // 生成随机 ID
    uid(prefix) {
      return (
        (prefix || '') +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 8)
      );
    },

    // 深拷贝
    clone(obj) {
      return JSON.parse(JSON.stringify(obj));
    },

    // 下载文件
    download(filename, content, mimeType) {
      const blob = new Blob([content], {
        type: mimeType || 'application/octet-stream',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },

    // 复制到剪贴板
    async copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        return true;
      }
    },
  };

  // ---------- 通用 UI 组件 ----------
  const ui = {
    // Toast 提示
    _toastEl: null,
    _toastTimer: null,
    toast(message, type, duration) {
      if (!this._toastEl) {
        this._toastEl = document.createElement('div');
        this._toastEl.className = 'toast';
        document.body.appendChild(this._toastEl);
      }
      this._toastEl.textContent = message;
      this._toastEl.className = 'toast show' + (type ? ' ' + type : '');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => {
        this._toastEl.classList.remove('show');
      }, duration || 2500);
    },

    // 确认对话框
    confirm(message, title) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay open';
        overlay.innerHTML = `
          <div class="slf-modal" style="max-width:400px">
            <div class="slf-modal-head">
              <h2>${utils.esc(title || i18n.t('confirm') || '确认')}</h2>
              <button class="slf-modal-close" data-action="cancel" aria-label="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div class="slf-modal-body">
              <p style="font-size:15px;color:var(--gray-600)">${utils.esc(message)}</p>
            </div>
            <div class="slf-modal-foot">
              <button class="btn btn-secondary" data-action="cancel">${i18n.t('cancel') || '取消'}</button>
              <button class="btn btn-primary" data-action="ok">${i18n.t('confirm') || '确认'}</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);

        const cleanup = (result) => {
          overlay.remove();
          resolve(result);
        };
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) cleanup(false);
          const action = e.target.dataset.action;
          if (action === 'cancel') cleanup(false);
          if (action === 'ok') cleanup(true);
        });
      });
    },

    // 输入对话框
    prompt(message, defaultValue, title) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay open';
        overlay.innerHTML = `
          <div class="slf-modal" style="max-width:420px">
            <div class="slf-modal-head">
              <h2>${utils.esc(title || i18n.t('input') || '请输入')}</h2>
              <button class="slf-modal-close" data-action="cancel" aria-label="关闭">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div class="slf-modal-body">
              <p style="font-size:14px;color:var(--gray-600);margin-bottom:12px;">${utils.esc(message)}</p>
              <input type="text" class="modal-input" value="${utils.esc(defaultValue || '')}" style="width:100%;padding:12px 14px;border:1px solid var(--gray-300);border-radius:10px;font-size:15px;outline:none;transition:border-color .2s,box-shadow .2s;" onfocus="this.style.borderColor='var(--primary)';this.style.boxShadow='0 0 0 3px rgba(232,93,58,.15)'" onblur="this.style.borderColor='var(--gray-300)';this.style.boxShadow='none'">
            </div>
            <div class="slf-modal-foot">
              <button class="btn btn-secondary" data-action="cancel">${i18n.t('cancel') || '取消'}</button>
              <button class="btn btn-primary" data-action="ok">${i18n.t('confirm') || '确定'}</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        const input = overlay.querySelector('.modal-input');
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') overlay.querySelector('[data-action="ok"]').click();
          if (e.key === 'Escape') overlay.querySelector('[data-action="cancel"]').click();
        });
        const cleanup = (result) => {
          overlay.remove();
          resolve(result);
        };
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) cleanup(null);
          const action = e.target.dataset.action;
          if (action === 'cancel') cleanup(null);
          if (action === 'ok') cleanup(input.value);
        });
      });
    },

    // 打开模态框（基于已存在的 DOM）
    openModal(selector) {
      const el =
        typeof selector === 'string'
          ? document.querySelector(selector)
          : selector;
      if (el) el.classList.add('open');
    },

    closeModal(selector) {
      const el =
        typeof selector === 'string'
          ? document.querySelector(selector)
          : selector;
      if (el) el.classList.remove('open');
    },
  };

  // ---------- 认证辅助 ----------
  const auth = {
    // 管理员
    getAdminKey() {
      return sessionStorage.getItem(CONFIG.STORAGE_KEYS.adminKey);
    },
    setAdminKey(key) {
      sessionStorage.setItem(CONFIG.STORAGE_KEYS.adminKey, key);
    },
    clearAdmin() {
      sessionStorage.removeItem(CONFIG.STORAGE_KEYS.adminKey);
    },
    isAdminLoggedIn() {
      return !!this.getAdminKey();
    },

    // 服务员
    getWaiterToken() {
      return (
        localStorage.getItem(CONFIG.STORAGE_KEYS.waiterToken) ||
        localStorage.getItem(CONFIG.STORAGE_KEYS.kitchenToken)
      );
    },
    setWaiterToken(token, scope) {
      const key =
        scope === 'kitchen'
          ? CONFIG.STORAGE_KEYS.kitchenToken
          : CONFIG.STORAGE_KEYS.waiterToken;
      localStorage.setItem(key, token);
    },
    clearWaiter(scope) {
      if (scope === 'kitchen') {
        localStorage.removeItem(CONFIG.STORAGE_KEYS.kitchenToken);
      } else if (scope === 'waiter') {
        localStorage.removeItem(CONFIG.STORAGE_KEYS.waiterToken);
      } else {
        localStorage.removeItem(CONFIG.STORAGE_KEYS.waiterToken);
        localStorage.removeItem(CONFIG.STORAGE_KEYS.kitchenToken);
      }
    },

    // 店铺
    getStoreId() {
      return parseInt(localStorage.getItem(CONFIG.STORAGE_KEYS.storeId) || '1', 10);
    },
    setStoreId(id) {
      localStorage.setItem(CONFIG.STORAGE_KEYS.storeId, String(id));
    },
  };

  // ---------- 导出到全局 ----------
  global.SLF = {
    CONFIG,
    api,
    i18n,
    utils,
    ui,
    auth,
    ApiClient,
    I18n,
  };

  // 兼容旧代码：提供全局 t 函数快捷方式
  global.t = function (key, params) {
    return i18n.t(key, params);
  };
  global.esc = utils.esc;
})(window);
