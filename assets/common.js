/* ============================================================
   FoodFlow Ordering System - Common JS Library (Common JS)
   鎵€鏈夐〉闈㈠叡浜鏂囦欢锛屾彁渚?API 瀹㈡埛绔€乮18n銆佸伐鍏峰嚱鏁?
   ============================================================ */

(function (global) {
  'use strict';

  // ---------- 閰嶇疆 ----------
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

  // ---------- 缁熶竴 API 瀹㈡埛绔?----------
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

      // FormData 鏃剁Щ闄?Content-Type锛岃娴忚鍣ㄨ嚜鍔ㄨ缃?boundary
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

  // ---------- 缁熶竴 i18n 缈昏瘧绯荤粺 ----------
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
      // 鍚堝苟鍏ㄥ眬 LANGUAGES锛堝鏋滃瓨鍦紝浣滀负鍥為€€锛?
      if (typeof LANGUAGES !== 'undefined') {
        for (const [code, dict] of Object.entries(LANGUAGES)) {
          this.dicts[code] = { ...(this.dicts[code] || {}), ...dict };
        }
      }
    }

    // 鍔ㄦ€佸姞杞芥寚瀹氳瑷€鐨勭炕璇戯紙鏂规浜岋細鎸夐渶浠嶢PI鍔犺浇锛屽噺灏戝垵濮嬩綋绉級
    async loadLanguage(lang) {
      const validLangs = ['zh', 'en', 'vi', 'th', 'km'];
      if (!validLangs.includes(lang)) lang = 'zh';
      // 检查内存缓存
      if (this.dicts[lang] && this.dicts[lang]._loaded) {
        this.lang = lang;
        return true;
      }
      // 检查localStorage缓存
      try {
        const cached = localStorage.getItem('i18n_' + lang);
        if (cached) {
          const data = JSON.parse(cached);
          this.dicts[lang] = { ...data, _loaded: true };
          this.lang = lang;
          return true;
        }
      } catch (e) {}
      // 浠嶢PI鍔ㄦ€佸姞杞?
      try {
        const res = await fetch('/api/i18n/' + lang);
        if (res.ok) {
          const data = await res.json();
          this.dicts[lang] = { ...data, _loaded: true };
          this.lang = lang;
          // 缓存到localStorage（24小时）
          try {
            localStorage.setItem('i18n_' + lang, JSON.stringify(data));
          } catch (e) {}
          return true;
        }
      } catch (e) {
        console.warn('i18n dynamic load failed, using fallback:', e.message);
      }
      // 加载失败，回退到全局LANGUAGES或中文
      this.lang = this.dicts[lang] ? lang : this.fallbackLang;
      return false;
    }

    setLang(lang) {
      this.lang = lang;
    }

    t(key, params) {
      const dict = this.dicts[this.lang] || {};
      const fallback = this.dicts[this.fallbackLang] || {};
      let value = dict[key] ?? fallback[key] ?? key;

      // 鏀寔宓屽 categories 绛夊璞?
      if (typeof value === 'object' && value !== null) {
        return value;
      }

      // 鏀寔鍙傛暟鏇挎崲 {0}, {1} 鎴?{name}
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

    // 鑾峰彇鍒嗙被缈昏瘧
    category(name) {
      const cats = this.t('categories');
      if (cats && typeof cats === 'object' && cats[name]) return cats[name];
      return name;
    }

    // 鑾峰彇褰撳墠璇█鐨勮揣甯佷俊鎭?
    currency() {
      const dict = this.dicts[this.lang] || this.dicts[this.fallbackLang] || {};
      return {
        symbol: dict.currencySymbol || '楼',
        rate: Number(dict.currencyRate) || 1,
        code: dict.currencyCode || this.lang.toUpperCase(),
      };
    }

    // 鏍煎紡鍖栦环鏍硷紙鍩虹璐у竵 USD -> 褰撳墠璇█璐у竵锛?
    formatPrice(basePrice, baseCurrency) {
      const cur = this.currency();
      const rate = cur.rate || 1;
      const converted = Number(basePrice) * rate;
      // 澶ч璐у竵锛圴ND/KHR锛変笉鏄剧ず灏忔暟
      const decimals = rate >= 1000 ? 0 : 2;
      return `${cur.symbol}${converted.toFixed(decimals)}`;
    }
  }

  const i18n = new I18n();

  // ---------- 宸ュ叿鍑芥暟 ----------
  const utils = {
    // HTML 杞箟
    esc(str) {
      return String(str ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c]));
    },

    // 闃叉姈
    debounce(fn, delay) {
      let timer;
      return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
      };
    },

    // 鑺傛祦
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

    // 鏍煎紡鍖栨棩鏈熸椂闂达紙鍏ㄧ悆閫氱敤鏍煎紡 YYYY-MM-DD HH:mm:ss锛?
    formatDateTime(isoStr) {
      try {
        const d = new Date(isoStr);
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      } catch {
        return isoStr;
      }
    },
    // 鏍煎紡鍖栨椂闂达紙鍏ㄧ悆閫氱敤鏍煎紡 HH:mm:ss锛?
    formatTime(date) {
      try {
        const d = date instanceof Date ? date : new Date(date);
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      } catch {
        return '';
      }
    },

    // 鐩稿鏃堕棿
    timeAgo(isoStr) {
      const diff = Date.now() - new Date(isoStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return { text: i18n.t('justNow') || '鍒氬垰', level: 'ok' };
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

    // 鐢熸垚闅忔満 ID
    uid(prefix) {
      return (
        (prefix || '') +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 8)
      );
    },

    // 娣辨嫹璐?
    clone(obj) {
      return JSON.parse(JSON.stringify(obj));
    },

    // 涓嬭浇鏂囦欢
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

    // 澶嶅埗鍒板壀璐存澘
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

  // ---------- 閫氱敤 UI 缁勪欢 ----------
  const ui = {
    // Toast 鎻愮ず
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

    // 纭瀵硅瘽妗?
    confirm(message, title) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay open';
        overlay.innerHTML = `
          <div class="slf-modal" style="max-width:400px">
            <div class="slf-modal-head">
              <h2>${utils.esc(title || i18n.t('confirm') || '纭')}</h2>
              <button class="slf-modal-close" data-action="cancel" aria-label="鍏抽棴">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div class="slf-modal-body">
              <p style="font-size:15px;color:var(--gray-600)">${utils.esc(message)}</p>
            </div>
            <div class="slf-modal-foot">
              <button class="btn btn-secondary" data-action="cancel">${i18n.t('cancel') || '鍙栨秷'}</button>
              <button class="btn btn-primary" data-action="ok">${i18n.t('confirm') || '纭'}</button>
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

    // 杈撳叆瀵硅瘽妗?
    prompt(message, defaultValue, title) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay open';
        overlay.innerHTML = `
          <div class="slf-modal" style="max-width:420px">
            <div class="slf-modal-head">
              <h2>${utils.esc(title || i18n.t('input') || '请输入')}</h2>
              <button class="slf-modal-close" data-action="cancel" aria-label="鍏抽棴">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div class="slf-modal-body">
              <p style="font-size:14px;color:var(--gray-600);margin-bottom:12px;">${utils.esc(message)}</p>
              <input type="text" class="modal-input" value="${utils.esc(defaultValue || '')}" style="width:100%;padding:12px 14px;border:1px solid var(--gray-300);border-radius:10px;font-size:15px;outline:none;transition:border-color .2s,box-shadow .2s;" onfocus="this.style.borderColor='var(--primary)';this.style.boxShadow='0 0 0 3px rgba(232,93,58,.15)'" onblur="this.style.borderColor='var(--gray-300)';this.style.boxShadow='none'">
            </div>
            <div class="slf-modal-foot">
              <button class="btn btn-secondary" data-action="cancel">${i18n.t('cancel') || '鍙栨秷'}</button>
              <button class="btn btn-primary" data-action="ok">${i18n.t('confirm') || '纭畾'}</button>
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

    // 鎵撳紑妯℃€佹锛堝熀浜庡凡瀛樺湪鐨?DOM锛?
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

  // ---------- 璁よ瘉杈呭姪 ----------
  const auth = {
    // 绠＄悊鍛?
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

    // 鏈嶅姟鍛?
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

    // 搴楅摵
    getStoreId() {
      return parseInt(localStorage.getItem(CONFIG.STORAGE_KEYS.storeId) || '1', 10);
    },
    setStoreId(id) {
      localStorage.setItem(CONFIG.STORAGE_KEYS.storeId, String(id));
    },
  };

  // ---------- 闊抽宸ュ叿 ----------
  const audio = {
    _ctx: null,
    _enabled: true,

    // 瑙ｉ攣闊抽涓婁笅鏂囷紙蹇呴』鍦ㄧ敤鎴蜂氦浜掑悗璋冪敤锛?
    unlock() {
      if (!this._ctx) {
        try {
          this._ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
          // 娴忚鍣ㄤ笉鏀寔 Web Audio
        }
      }
      if (this._ctx && this._ctx.state === 'suspended') {
        this._ctx.resume().catch(() => {});
      }
    },

    // 璁剧疆澹伴煶寮€鍏?
    setEnabled(enabled) {
      this._enabled = !!enabled;
    },

    // 鑾峰彇澹伴煶寮€鍏崇姸鎬?
    isEnabled() {
      return this._enabled;
    },

    // 鎾斁鏂拌鍗曟彁绀洪煶锛圕澶ц皟涓婅鐞堕煶锛屾偊鑰虫剦鎮︼紝鍝嶄寒娓呮櫚锛?
    playNewOrderChime() {
      if (!this._enabled) return;
      this.unlock();
      if (!this._ctx) return;
      try {
        const now = this._ctx.currentTime;
        // C澶ц皟涓婅鐞堕煶锛欳5鈫扙5鈫扜5鈫扖6鈫扙6锛屾剦鎮︿笂鎵?
        // 棰戠巼锛欳5=523.25, E5=659.25, G5=783.99, C6=1046.50, E6=1318.51
        const notes = [
          [0, 523.25],
          [0.15, 659.25],
          [0.30, 783.99],
          [0.45, 1046.50],
          [0.60, 1318.51]
        ];
        notes.forEach(([t, freq], idx) => {
          const isLast = idx === notes.length - 1;
          const osc = this._ctx.createOscillator();
          const gain = this._ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.value = freq;
          const duration = isLast ? 0.8 : 0.3;
          const peak = 1.0;
          gain.gain.setValueAtTime(0.0001, now + t);
          gain.gain.exponentialRampToValueAtTime(peak, now + t + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + t + duration);
          osc.connect(gain).connect(this._ctx.destination);
          osc.start(now + t);
          osc.stop(now + t + duration + 0.05);
        });
      } catch (e) {
        // 蹇界暐闊抽鎾斁閿欒
      }
    },

    // 鎾斁鍌崟鎻愮ず闊筹紙鎬ヤ績鐨勫洓澹帮級
    playUrgeChime() {
      if (!this._enabled) return;
      this.unlock();
      if (!this._ctx) return;
      try {
        const now = this._ctx.currentTime;
        const compressor = this._ctx.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-12, now);
        compressor.knee.setValueAtTime(20, now);
        compressor.ratio.setValueAtTime(8, now);
        compressor.attack.setValueAtTime(0.003, now);
        compressor.release.setValueAtTime(0.15, now);
        compressor.connect(this._ctx.destination);
        [[0, 1000], [0.15, 1400], [0.30, 1000], [0.45, 1400]].forEach(([t, freq]) => {
          [freq, freq * 1.5].forEach((f, i) => {
            const osc = this._ctx.createOscillator();
            const gain = this._ctx.createGain();
            osc.type = 'square';
            osc.frequency.value = f;
            const peak = i === 0 ? 1.0 : 0.5;
            gain.gain.setValueAtTime(0.0001, now + t);
            gain.gain.exponentialRampToValueAtTime(peak, now + t + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.12);
            osc.connect(gain).connect(compressor);
            osc.start(now + t);
            osc.stop(now + t + 0.15);
          });
        });
      } catch (e) {
        // 蹇界暐闊抽鎾斁閿欒
      }
    },

    // 鎾斁鍛煎彨鏈嶅姟鍛?鍌崟鎻愮ず闊筹紙涓夊０娓呰剢鍙挌锛屾洿鎬ヤ績锛?
    playCallChime() {
      if (!this._enabled) return;
      this.unlock();
      if (!this._ctx) return;
      try {
        const now = this._ctx.currentTime;
        const compressor = this._ctx.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-12, now);
        compressor.knee.setValueAtTime(20, now);
        compressor.ratio.setValueAtTime(8, now);
        compressor.attack.setValueAtTime(0.003, now);
        compressor.release.setValueAtTime(0.15, now);
        compressor.connect(this._ctx.destination);
        [[0, 1200], [0.2, 1600], [0.4, 1200]].forEach(([t, freq]) => {
          [freq, freq * 1.5].forEach((f, i) => {
            const osc = this._ctx.createOscillator();
            const gain = this._ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = f;
            const peak = i === 0 ? 1.0 : 0.5;
            gain.gain.setValueAtTime(0.0001, now + t);
            gain.gain.exponentialRampToValueAtTime(peak, now + t + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.3);
            osc.connect(gain).connect(compressor);
            osc.start(now + t);
            osc.stop(now + t + 0.35);
          });
        });
      } catch (e) {
        // 蹇界暐闊抽鎾斁閿欒
      }
    },
  };

  // ---------- 瀵煎嚭鍒板叏灞€ ----------
  global.SLF = {
    CONFIG,
    api,
    i18n,
    utils,
    ui,
    auth,
    audio,
    ApiClient,
    I18n,
  };

  // 鍏煎鏃т唬鐮侊細鎻愪緵鍏ㄥ眬 t 鍑芥暟蹇嵎鏂瑰紡
  global.t = function (key, params) {
    return i18n.t(key, params);
  };
  global.esc = utils.esc;
})(window);
