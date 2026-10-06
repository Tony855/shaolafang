/* FoodFlow · SLF.pwa — SW 注册 + A2HS 横幅 + iOS 引导 + 自动更新横幅 */
(function (global) {
  'use strict';
  var SLF = global.SLF = global.SLF || {};

  /* ---- SW 注册（仅 HTTPS/localhost）---- */
  var _refreshing = false;
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    var isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (location.protocol !== 'https:' && !isLocal) return;

    navigator.serviceWorker.register('/service-worker.js', { scope: '/' })
      .then(function (reg) {
        if (SLF.log) SLF.log.info('[pwa] SW 已注册:', reg.scope);

        function checkUpdate() { reg.update().catch(function () {}); }
        window.addEventListener('focus', checkUpdate);
        setInterval(checkUpdate, 60 * 60 * 1000);

        reg.addEventListener('updatefound', function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', function () {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              showUpdateBanner();
            }
          });
        });
      })
      .catch(function (err) { if (SLF.log) SLF.log.warn('[pwa] SW 注册失败:', err.message); });

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (_refreshing) return;
      _refreshing = true;
      window.location.reload();
    });
  }

  function isStandalone() {
    return (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches)
        || global.navigator.standalone === true;
  }
  function isIOS() {
    var ua = global.navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) && !global.MSStream;
  }
  function isIOSSafari() {
    if (!isIOS()) return false;
    var ua = global.navigator.userAgent || '';
    return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  }
  function recentlyShown() {
    try {
      var last = localStorage.getItem('pwa_install_prompt_last');
      return last && (Date.now() - parseInt(last, 10)) < 24 * 3600 * 1000;
    } catch (e) { return false; }
  }
  function markShown() {
    try { localStorage.setItem('pwa_install_prompt_last', String(Date.now())); } catch (e) {}
  }

  function injectStyle() {
    if (document.getElementById('slf-pwa-style')) return;
    var style = document.createElement('style');
    style.id = 'slf-pwa-style';
    style.textContent = [
      '.pwa-install-banner{position:fixed;left:12px;right:12px;bottom:12px;z-index:99998;',
      'background:linear-gradient(135deg,#1f2937,#111827);color:#fff;border-radius:16px;',
      'padding:14px 16px;box-shadow:0 12px 40px rgba(0,0,0,.4);display:flex;align-items:center;gap:12px;',
      'opacity:0;transform:translateY(20px);transition:opacity .3s,transform .3s;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}',
      '.pwa-install-banner.show{opacity:1;transform:translateY(0);}',
      '.pwa-install-banner .pwa-install-icon{font-size:32px;flex-shrink:0;}',
      '.pwa-install-banner .pwa-install-text{flex:1;min-width:0;}',
      '.pwa-install-banner .pwa-install-title{font-size:15px;font-weight:700;margin-bottom:2px;}',
      '.pwa-install-banner .pwa-install-desc{font-size:12px;color:#9ca3af;line-height:1.4;}',
      '.pwa-install-banner .pwa-install-btn{flex-shrink:0;background:linear-gradient(135deg,#ff8a4c,#e84a2a);',
      'color:#fff;border:0;border-radius:10px;padding:10px 16px;font-size:13px;font-weight:700;cursor:pointer;',
      'box-shadow:0 4px 12px rgba(232,74,42,.35);}',
      '.pwa-install-banner .pwa-install-btn:active{transform:scale(.96);}',
      '.pwa-install-banner .pwa-install-btn:disabled{opacity:.6;cursor:wait;}',
      '.pwa-install-banner .pwa-install-close{flex-shrink:0;background:transparent;border:0;color:#6b7280;',
      'font-size:16px;cursor:pointer;padding:4px 6px;line-height:1;}',
      '.pwa-install-banner .pwa-install-close:hover{color:#fff;}',
      '.pwa-ios-guide{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(6px);',
      'z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;',
      'opacity:0;transition:opacity .3s;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;}',
      '.pwa-ios-guide.show{opacity:1;}',
      '.pwa-ios-guide-card{background:#fff;border-radius:20px;padding:28px 24px 20px;max-width:340px;width:100%;',
      'text-align:center;color:#1f2937;box-shadow:0 20px 60px rgba(0,0,0,.3);}',
      '.pwa-ios-guide-title{font-size:19px;font-weight:800;margin-bottom:20px;}',
      '.pwa-ios-guide-steps{list-style:none;padding:0;margin:0 0 20px;text-align:left;}',
      '.pwa-ios-guide-steps li{display:flex;align-items:center;gap:12px;padding:10px 0;',
      'border-bottom:1px solid #f0f0f0;font-size:14px;line-height:1.5;}',
      '.pwa-ios-guide-steps li:last-child{border-bottom:0;}',
      '.pwa-ios-guide-icon{font-size:22px;flex-shrink:0;width:32px;text-align:center;}',
      '.pwa-ios-guide-close{width:100%;padding:13px;background:linear-gradient(135deg,#ff8a4c,#e84a2a);',
      'color:#fff;border:0;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;}'
    ].join('');
    document.head.appendChild(style);
  }

  function applyI18n(root) {
    if (!SLF.i18n || typeof SLF.i18n.t !== 'function') return;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      var text = SLF.i18n.t(key);
      if (text && text !== key) el.textContent = text;
    });
  }

  /* ---- 安装横幅 ---- */
  var bannerEl = null;
  function showBanner(onInstall) {
    if (bannerEl) return;
    injectStyle();
    bannerEl = document.createElement('div');
    bannerEl.className = 'pwa-install-banner';
    bannerEl.id = 'pwaInstallBanner';
    bannerEl.innerHTML = ''
      + '<div class="pwa-install-icon">📱</div>'
      + '<div class="pwa-install-text">'
      +   '<div class="pwa-install-title" data-i18n="pwaInstallTitle">添加到主屏幕</div>'
      +   '<div class="pwa-install-desc" data-i18n="pwaInstallDesc">像 App 一样使用，无需再扫码</div>'
      + '</div>'
      + '<button class="pwa-install-btn" data-i18n="pwaInstallBtn">立即添加</button>'
      + '<button class="pwa-install-close" aria-label="close">✕</button>';
    document.body.appendChild(bannerEl);
    applyI18n(bannerEl);
    requestAnimationFrame(function () { bannerEl.classList.add('show'); });

    // iOS 使用 touchstart + click 双保险（iOS 有时 click 事件不触发）
    var _btn = bannerEl.querySelector('.pwa-install-btn');
    var _closeBtn = bannerEl.querySelector('.pwa-install-close');

    function _onInstallTap(e) {
      e.preventDefault();
      e.stopPropagation();
      console.log('[pwa] 安装按钮被点击');
      try {
        markShown();
        if (typeof onInstall === 'function') {
          console.log('[pwa] 调用 onInstall');
          onInstall();
        } else {
          console.error('[pwa] onInstall 不是函数:', typeof onInstall);
          alert('请使用 Safari 底部「分享」→「添加到主屏幕」');
        }
      } catch (err) {
        console.error('[pwa] onInstall 异常:', err);
        alert('安装引导异常: ' + err.message);
      }
    }

    function _onCloseTap(e) {
      e.preventDefault();
      e.stopPropagation();
      markShown();
      hideBanner();
    }

    // 同时绑 click 和 touchstart（iOS 有时 touchstart 更快触发）
    _btn.addEventListener('click', _onInstallTap);
    _btn.addEventListener('touchend', _onInstallTap);
    _closeBtn.addEventListener('click', _onCloseTap);
    _closeBtn.addEventListener('touchend', _onCloseTap);
  }
  function hideBanner() {
    if (!bannerEl) return;
    bannerEl.classList.remove('show');
    setTimeout(function () {
      if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
      bannerEl = null;
    }, 350);
  }

  /* ---- iOS 引导 ---- */
  function showIOSGuide() {
    injectStyle();
    var ov = document.createElement('div');
    ov.className = 'pwa-ios-guide';
    ov.innerHTML = ''
      + '<div class="pwa-ios-guide-card">'
      +   '<div class="pwa-ios-guide-title" data-i18n="pwaIOSGuideTitle">添加到主屏幕</div>'
      +   '<ol class="pwa-ios-guide-steps">'
      +     '<li><span class="pwa-ios-guide-icon">⬆️</span><span data-i18n="pwaIOSStep1">点击底部「分享」按钮</span></li>'
      +     '<li><span class="pwa-ios-guide-icon">➕</span><span data-i18n="pwaIOSStep2">选择「添加到主屏幕」</span></li>'
      +     '<li><span class="pwa-ios-guide-icon">✓</span><span data-i18n="pwaIOSStep3">点击「添加」完成</span></li>'
      +   '</ol>'
      +   '<button class="pwa-ios-guide-close" data-i18n="pwaGotIt">知道了</button>'
      + '</div>';
    document.body.appendChild(ov);
    applyI18n(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });
    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.classList.contains('pwa-ios-guide-close')) {
        ov.classList.remove('show');
        setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 350);
      }
    });
  }

  /* ---- 更新横幅 ---- */
  var updateBannerEl = null;
  function showUpdateBanner() {
    if (updateBannerEl) return;
    injectStyle();
    updateBannerEl = document.createElement('div');
    updateBannerEl.className = 'pwa-install-banner';
    updateBannerEl.id = 'pwaUpdateBanner';
    updateBannerEl.innerHTML = ''
      + '<div class="pwa-install-icon">🔄</div>'
      + '<div class="pwa-install-text">'
      +   '<div class="pwa-install-title">发现新版本</div>'
      +   '<div class="pwa-install-desc">点击右侧按钮立即更新</div>'
      + '</div>'
      + '<button class="pwa-install-btn" id="pwaUpdateBtn">立即刷新</button>'
      + '<button class="pwa-install-close" id="pwaUpdateClose">✕</button>';
    document.body.appendChild(updateBannerEl);
    requestAnimationFrame(function () { updateBannerEl.classList.add('show'); });

    updateBannerEl.querySelector('#pwaUpdateBtn').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = '刷新中...';
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (reg && reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          setTimeout(function () { window.location.reload(); }, 1500);
        } else {
          window.location.reload();
        }
      });
    });

    updateBannerEl.querySelector('#pwaUpdateClose').addEventListener('click', function () {
      updateBannerEl.classList.remove('show');
      setTimeout(function () {
        if (updateBannerEl && updateBannerEl.parentNode) {
          updateBannerEl.parentNode.removeChild(updateBannerEl);
        }
        updateBannerEl = null;
      }, 350);
    });
  }

  /* ---- 初始化 ---- */
  var deferredPrompt = null;
  function init() {
    registerSW();
    if (isStandalone()) return;
    if (recentlyShown()) return;

    global.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredPrompt = e;
      setTimeout(function () {
        if (isStandalone()) return;
        showBanner(function () {
          if (!deferredPrompt) return;
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then(function (choice) {
            if (choice.outcome === 'accepted') hideBanner();
            deferredPrompt = null;
          });
        });
      }, 3000);
    });

    if (isIOSSafari()) {
      setTimeout(function () {
        if (isStandalone()) return;
        showBanner(function () { showIOSGuide(); });
      }, 5000);
    }
  }

  SLF.pwa = { init: init, isStandalone: isStandalone, isIOS: isIOS,
              showBanner: showBanner, hideBanner: hideBanner, showIOSGuide: showIOSGuide,
              showUpdateBanner: showUpdateBanner };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
