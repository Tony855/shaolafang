/* ============================================================
   FoodFlow 点餐系统 - UI 模块 (modules/ui.js)
   依赖：core.js（SLF）
   内容：
     1. 原 core.js 的 dom 工具（$ / $$ / setText / setHTML / create ...）
     2. 统一 toast（自注入容器，全页面共用）
     3. 通用 confirm（返回 Promise<boolean>）
     4. 通用 loading（showLoading / hideLoading）
   所有页面只调用 SLF.ui.*
   ============================================================ */

(function (global) {
  'use strict';

  const SLF = global.SLF;
  if (!SLF) throw new Error('ui.js 需在 core.js 之后加载');

  /* ------------------------------------------------------------
     注入一次性样式
     ------------------------------------------------------------ */
  const STYLE = `
.slf-toast{position:fixed;top:18%;left:50%;transform:translateX(-50%) translateY(-12px);
  background:rgba(40,40,45,.92);color:#fff;padding:11px 20px;border-radius:10px;
  font-size:14px;line-height:1.5;z-index:100000;max-width:86%;text-align:center;
  opacity:0;pointer-events:none;transition:opacity .22s ease,transform .22s ease;
  box-shadow:0 6px 24px rgba(0,0,0,.22)}
.slf-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.slf-toast.success{background:rgba(38,166,91,.95)}
.slf-toast.error{background:rgba(214,69,69,.95)}
.slf-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100001;
  display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .18s}
.slf-modal-mask.show{opacity:1}
.slf-modal-box{background:#fff;border-radius:14px;width:88%;max-width:340px;overflow:hidden;
  box-shadow:0 12px 40px rgba(0,0,0,.28)}
.slf-modal-msg{padding:24px 20px;font-size:15px;color:#333;text-align:center;line-height:1.6}
.slf-modal-btns{display:flex;border-top:1px solid #eee}
.slf-modal-btns button{flex:1;border:0;background:#fff;padding:13px 0;font-size:15px;min-height:46px;cursor:pointer}
.slf-modal-btns button.ok{color:#e85d3a;font-weight:600}
.slf-modal-btns button.cancel{color:#888;border-right:1px solid #eee}
.slf-loading{position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:100002;
  display:none;align-items:center;justify-content:center}
.slf-loading.show{display:flex}
.slf-loading .box{background:rgba(0,0,0,.78);color:#fff;padding:18px 22px;border-radius:12px;
  font-size:14px;display:flex;align-items:center;gap:10px}
.slf-spin{width:18px;height:18px;border:2px solid rgba(255,255,255,.35);
  border-top-color:#fff;border-radius:50%;animation:slf-spin .8s linear infinite}
@keyframes slf-spin{to{transform:rotate(360deg)}}
`;

  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------
     DOM 工具（原 core.js dom 模块）
     ------------------------------------------------------------ */
  const dom = {
    esc(str) {
      return String(str ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    },

    $(selector, parent = document) {
      return parent.querySelector(selector);
    },

    $$(selector, parent = document) {
      return Array.from(parent.querySelectorAll(selector));
    },

    setText(selector, text, parent) {
      const el = this.$(selector, parent);
      if (el) el.textContent = text;
      return el;
    },

    setHTML(selector, html, parent) {
      const el = this.$(selector, parent);
      if (el) el.innerHTML = html;
      return el;
    },

    setTitle(title) {
      document.title = title;
    },

    addClass(selector, className, parent) {
      const el = this.$(selector, parent);
      if (el) el.classList.add(className);
      return el;
    },

    removeClass(selector, className, parent) {
      const el = this.$(selector, parent);
      if (el) el.classList.remove(className);
      return el;
    },

    toggleClass(selector, className, parent) {
      const el = this.$(selector, parent);
      if (el) el.classList.toggle(className);
      return el;
    },

    show(selector, parent) {
      return this.removeClass(selector, 'hidden', parent);
    },

    hide(selector, parent) {
      return this.addClass(selector, 'hidden', parent);
    },

    create(tag, attrs = {}, children = []) {
      const el = document.createElement(tag);
      Object.keys(attrs).forEach(key => {
        if (key === 'className') el.className = attrs[key];
        else if (key === 'style') el.style.cssText = attrs[key];
        else if (key.startsWith('on') && typeof attrs[key] === 'function') {
          el.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
        } else el.setAttribute(key, attrs[key]);
      });
      children.forEach(child => {
        if (typeof child === 'string') el.appendChild(document.createTextNode(child));
        else if (child instanceof Node) el.appendChild(child);
      });
      return el;
    },

    empty(selector, parent) {
      const el = this.$(selector, parent);
      if (el) el.innerHTML = '';
      return el;
    },
  };

  /* ------------------------------------------------------------
     Toast（自注入容器，智能兼容旧调用签名）
       toast(msg)
       toast(msg, 'success'|'error')
       toast(msg, duration)            // 数字第二参数 = 时长
       toast(msg, type, duration)
     ------------------------------------------------------------ */
  let toastEl = null;
  let toastTimer = null;

  function ensureToast() {
    if (toastEl) return toastEl;
    toastEl = document.createElement('div');
    toastEl.className = 'slf-toast';
    document.body.appendChild(toastEl);
    return toastEl;
  }

  function toast(message, typeOrDuration = '', duration = 2200) {
    let type = '';
    if (typeof typeOrDuration === 'number') {
      duration = typeOrDuration;
    } else {
      type = typeOrDuration;
    }
    const el = ensureToast();
    el.textContent = message;
    el.className = 'slf-toast' + (type ? ' ' + type : '');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  }

  /* ------------------------------------------------------------
     Confirm（返回 Promise，true=确定）
     ------------------------------------------------------------ */
  function confirm(message, okText, cancelText) {
    return new Promise(resolve => {
      const mask = document.createElement('div');
      mask.className = 'slf-modal-mask';
      mask.innerHTML = `
        <div class="slf-modal-box">
          <div class="slf-modal-msg"></div>
          <div class="slf-modal-btns">
            <button class="cancel"></button>
            <button class="ok"></button>
          </div>
        </div>`;
      mask.querySelector('.slf-modal-msg').textContent = message;
      const cancelBtn = mask.querySelector('.cancel');
      const okBtn = mask.querySelector('.ok');
      cancelBtn.textContent = cancelText || '取消';
      okBtn.textContent = okText || '确定';

      function close(result) {
        mask.classList.remove('show');
        setTimeout(() => { mask.remove(); resolve(result); }, 180);
      }
      cancelBtn.addEventListener('click', () => close(false));
      okBtn.addEventListener('click', () => close(true));
      mask.addEventListener('click', e => { if (e.target === mask) close(false); });

      document.body.appendChild(mask);
      requestAnimationFrame(() => mask.classList.add('show'));
    });
  }

  /* ------------------------------------------------------------
     Loading
     ------------------------------------------------------------ */
  let loadingEl = null;
  let loadingCount = 0;

  function showLoading(text) {
    if (!loadingEl) {
      loadingEl = document.createElement('div');
      loadingEl.className = 'slf-loading';
      loadingEl.innerHTML = `<div class="box"><span class="slf-spin"></span><span class="slf-loading-text"></span></div>`;
      document.body.appendChild(loadingEl);
    }
    loadingEl.querySelector('.slf-loading-text').textContent = text || '加载中...';
    loadingCount++;
    loadingEl.classList.add('show');
  }

  function hideLoading() {
    loadingCount = Math.max(0, loadingCount - 1);
    if (loadingCount === 0 && loadingEl) loadingEl.classList.remove('show');
  }

  /* ------------------------------------------------------------
     挂载
     ------------------------------------------------------------ */
  injectStyle();
  SLF.ui = Object.assign(dom, {
    /**
     * 遍历 root 下所有 [data-i18n]/[data-i18n-placeholder]/[data-i18n-title] 元素，
     * 用当前语言的翻译替换文本/placeholder/title
     * @param {Element} [root=document]
     */
    applyI18n(root) {
      root = root || document;
      const i18n = SLF.i18n;
      if (!i18n || typeof i18n.t !== 'function') return;
      root.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (!key) return;
        const v = i18n.t(key);
        if (v && v !== key) el.textContent = v;
      });
      root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (!key) return;
        const v = i18n.t(key);
        if (v && v !== key) el.placeholder = v;
      });
      root.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        if (!key) return;
        const v = i18n.t(key);
        if (v && v !== key) el.title = v;
      });
    },

    toast,
    confirm,
    showLoading,
    hideLoading,
  });

  // 兼容旧的全局快捷调用

  SLF.log.info('SLF ui.js 加载完成');
})(window);
