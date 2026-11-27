'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cashier = fs.readFileSync(path.join(__dirname, '..', 'assets', 'cashier.css'), 'utf8');

test('cashier ready-to-settle state has one active sky-blue visual definition', () => {
  const readyState = cashier.match(/\.pos-order-card\.status-pending\.ready-to-settle\s*\{[^}]*\}/s)?.[0] || '';
  assert.match(readyState, /#0ea5e9/);
  assert.doesNotMatch(readyState, /#2ecc71/);
  assert.doesNotMatch(cashier, /@keyframes\s+pos-ready-pulse\s*\{/);
  assert.match(cashier, /\.pos-order-card\.ready-to-settle\s*\{[^}]*pos-ready-pulse-sky/s);
  assert.equal((cashier.match(/\.pos-card-ready-tip\s*\{/g) || []).length, 1);
});
test('cashier refund button and focus styles do not retain obsolete overrides', () => {
  assert.equal((cashier.match(/\.pos-detail-btns \.btn-refund\s*\{/g) || []).length, 1);
  assert.match(cashier, /\.pos-detail-btns \.btn-refund\s*\{[^}]*max-width:\s*110px;/s);
  assert.equal((cashier.match(/\.refund-input:focus\s*\{/g) || []).length, 1);
  assert.match(cashier, /\.refund-input:focus\s*\{[^}]*border-color:\s*#ff7a3d;/s);
});


test('customer and waiter pages load shared styles before page-specific overrides', () => {
  const customerHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const waiterHtml = fs.readFileSync(path.join(__dirname, '..', 'waiter.html'), 'utf8');
  assert.ok(customerHtml.indexOf('assets/common.css') < customerHtml.indexOf('assets/customer.css'));
  assert.ok(waiterHtml.indexOf('assets/common.css') < waiterHtml.indexOf('assets/khqr-shared.css'));
  assert.ok(waiterHtml.indexOf('assets/khqr-shared.css') < waiterHtml.indexOf('assets/waiter.css'));
});


test('admin sidebar has no stale mobile widths', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  assert.doesNotMatch(admin, /\.admin-sidebar\s*\{[^}]*width:\s*(?:150|160)px/s);
  assert.match(admin, /width:\s*180px\s*!important/);
  assert.match(admin, /width:\s*170px\s*!important/);
});

test('cashier and waiter payment overlays preserve KHQR stacking order', () => {
  for (const pageCss of ['cashier.css', 'waiter.css']) {
    const css = fs.readFileSync(path.join(__dirname, '..', 'assets', pageCss), 'utf8');
    assert.match(css, /\.modal-overlay\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*300;/s);
    assert.match(css, /#khqrModal\.modal-overlay\s*\{\s*z-index:\s*999\s*!important;\s*\}/);
    assert.match(css, /#paymentModal\.modal-overlay\s*\{\s*z-index:\s*300;\s*\}/);
  }
});


test('super admin modal overlays stay above mobile navigation controls', () => {
  const superCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'super.css'), 'utf8');
  const modalBlock = superCss.match(/\.modal\s*\{([^}]*)\}/)?.[1] || '';
  const menuButtonBlock = superCss.match(/\.mobile-menu-btn\s*\{([^}]*)\}/)?.[1] || '';
  const topBarBlocks = [...superCss.matchAll(/\.super-top\s*\{([^}]*)\}/g)].map((match) => match[1]);
  const readZIndex = (block) => Number(block.match(/z-index:\s*(\d+)/)?.[1] || 0);
  const topBarZIndex = Math.max(0, ...topBarBlocks.map(readZIndex));

  assert.ok(readZIndex(modalBlock) > readZIndex(menuButtonBlock));
  assert.ok(readZIndex(modalBlock) > topBarZIndex);
  assert.equal(readZIndex(modalBlock), 400);
});

test('payment secondary styles stay scoped while shared primary buttons remain available', () => {
  const sharedCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'common.css'), 'utf8');
  assert.match(sharedCss, /\.payment-actions \.btn-secondary\s*\{/);
  assert.match(sharedCss, /\.payment-actions \.btn-secondary:hover\s*\{/);
  assert.match(sharedCss, /^\.btn-primary\s*\{/m);
  assert.match(sharedCss, /^\.btn-primary:hover\s*\{/m);
  assert.match(sharedCss, /\.btn-secondary\s*\{\s*background:\s*var\(--gray-100\)/);
  assert.doesNotMatch(sharedCss, /^\.btn-secondary\s*\{\s*background:\s*#f3f4f6/m);
  const cashierHtml = fs.readFileSync(path.join(__dirname, '..', 'cashier.html'), 'utf8');
  assert.match(cashierHtml, /class="btn btn-primary"[^>]*id="loginBtn"/);
});

test('admin 420px layout overrides are applied after legacy 480px rules', () => {
  const adminCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  const narrowMarker = adminCss.lastIndexOf('Keep narrow-phone overrides after all legacy 480px rules.');
  const sidebarMarker = adminCss.lastIndexOf('Keep the mobile admin sidebar directly below the header');
  const preceding480 = adminCss.lastIndexOf('@media (max-width: 480px)', narrowMarker);
  assert.ok(narrowMarker > preceding480, 'the narrow-phone layout block must follow the preceding legacy 480px rules');
  assert.ok(sidebarMarker > narrowMarker, 'sidebar synchronization overrides must follow the narrow-phone layout block');
  const narrowCss = adminCss.slice(narrowMarker, sidebarMarker);
  assert.match(narrowCss, /\.ff-admin \.top\s*\{[^}]*height:\s*48px/s);
  assert.match(narrowCss, /\.ff-admin \.top-right select\s*\{[^}]*font-size:\s*10px/s);
  assert.match(narrowCss, /\.ff-admin \.nav-item\s*\{[^}]*font-size:\s*12px/s);
});

test('cashier detail footer and actions stay in flex flow with iPhone safe-area padding', () => {
  const detailLayout = cashier.slice(
    cashier.indexOf('详情页底部布局：使用纵向 Flex'),
    cashier.indexOf('订单卡片 4 状态标记')
  );
  assert.match(detailLayout, /\.pos-detail > \.pos-detail-body\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;/s);
  assert.match(detailLayout, /\.pos-detail > \.pos-detail-footer\s*\{[^}]*position:\s*static\s*!important;/s);
  assert.match(detailLayout, /\.pos-detail > \.pos-detail-btns,[\s\S]*?position:\s*static\s*!important;/);
  assert.match(detailLayout, /padding-bottom:\s*max\(12px,\s*env\(safe-area-inset-bottom\)\)/);
  assert.doesNotMatch(detailLayout, /position:\s*(?:absolute|fixed)\s*!important|bottom:\s*(?:72|78)px|padding-bottom:\s*200px/);
});

test('cashier payment, KHQR, refund and confirmation dialogs stay within the dynamic safe viewport', () => {
  const modalLayout = cashier.slice(cashier.lastIndexOf('收银台弹窗：限制在动态视口内'));
  assert.match(modalLayout, /\.modal-overlay\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(modalLayout, /safe-area-inset-top/);
  assert.match(modalLayout, /safe-area-inset-bottom/);
  assert.match(modalLayout, /\.modal-overlay > \.payment-card,[\s\S]*?#confirmModal > \.modal\s*\{[^}]*max-height:\s*calc\(100dvh/s);
  assert.match(modalLayout, /overflow-y:\s*auto/);
  assert.match(modalLayout, /overscroll-behavior:\s*contain/);
  const cashierHtml = fs.readFileSync(path.join(__dirname, '..', 'cashier.html'), 'utf8');
  for (const id of ['paymentModal', 'khqrModal', 'refundModal', 'confirmModal']) {
    assert.match(cashierHtml, new RegExp('id="' + id + '"'));
  }
});

test('cashier refund modal does not retain unused legacy card and action selectors', () => {
  assert.doesNotMatch(cashier, /\.refund-card\s*\{|\.refund-title\s*\{|\.refund-amount-value\s*\{|\.refund-actions\s*\{/);
  assert.match(cashier, /\.refund-input-row/);
  assert.match(cashier, /\.refund-textarea/);
});


test('customer call confirmation stays within dynamic safe viewport on short screens', () => {
  const customer = fs.readFileSync(path.join(__dirname, '..', 'assets', 'customer.css'), 'utf8');
  const overlay = customer.match(/\.ff-customer \.confirm-overlay\s*\{([^}]*)\}/)?.[1] || '';
  const card = customer.match(/\.ff-customer \.confirm-card\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(overlay, /overflow-y:\s*auto/);
  assert.match(overlay, /safe-area-inset-top/);
  assert.match(overlay, /safe-area-inset-bottom/);
  assert.match(card, /100dvh/);
  assert.match(card, /overflow-y:\s*auto/);
  assert.match(customer, /@media \(max-width: 640px\)\s*\{\s*\.ff-customer \.confirm-overlay\s*\{\s*align-items:\s*flex-start;/);
});

test('customer cart drawer uses dynamic height and a shrinkable scrolling body', () => {
  const customer = fs.readFileSync(path.join(__dirname, '..', 'assets', 'customer.css'), 'utf8');
  const drawer = customer.match(/\.cart-drawer\s*\{([^}]*)\}/)?.[1] || '';
  const body = customer.match(/\.cart-drawer \.drawer-body\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(drawer, /max-height:\s*65dvh/);
  assert.match(drawer, /box-sizing:\s*border-box/);
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /overscroll-behavior:\s*contain/);
});


test('admin mobile sidebar uses dynamic viewport height at every responsive breakpoint', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  const matches = [...admin.matchAll(/height:\s*calc\(100vh - (56|58)px\);\s*height:\s*calc\(100dvh - \1px\);/g)];
  assert.ok(matches.length >= 3, 'all 1024px and 920px sidebar height declarations should include a dvh override');
});

test('login error dialog stays scrollable within dynamic safe viewport', () => {
  const login = fs.readFileSync(path.join(__dirname, '..', 'assets', 'login.css'), 'utf8');
  const overlay = login.match(/\.error-modal\s*\{([^}]*)\}/)?.[1] || '';
  const card = login.match(/\.error-modal-card\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(overlay, /overflow-y:\s*auto/);
  assert.match(overlay, /safe-area-inset-top/);
  assert.match(overlay, /safe-area-inset-bottom/);
  assert.match(card, /100dvh/);
  assert.match(card, /overflow-y:\s*auto/);
  assert.match(login, /@media \(max-width: 768px\)\s*\{\s*\.error-modal\s*\{\s*align-items:\s*flex-start;/);
});


test('QR print card fits the dynamic safe viewport and keeps its body scrollable', () => {
  const qr = fs.readFileSync(path.join(__dirname, '..', 'assets', 'qr-print.css'), 'utf8');
  const body = qr.match(/(?:^|\n)\s*body\s*\{([^}]*)\}/)?.[1] || '';
  const card = qr.match(/\.qr-card\s*\{([^}]*)\}/)?.[1] || '';
  const cardBody = qr.match(/\.card-body\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(body, /safe-area-inset-top/);
  assert.match(body, /safe-area-inset-bottom/);
  assert.match(card, /100dvh/);
  assert.match(cardBody, /min-height:\s*0/);
  assert.match(cardBody, /overflow-y:\s*auto/);
  const printRules = qr.slice(qr.indexOf('@media print'));
  assert.match(printRules, /max-height:\s*none\s*!important/);
  assert.match(printRules, /overflow:\s*visible\s*!important/);
});


test('menu display uses the dynamic safe viewport without clipping its flex layout', () => {
  const display = fs.readFileSync(path.join(__dirname, '..', 'assets', 'menu-display.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'menu-display.html'), 'utf8');
  const body = display.match(/(^|\n)body\s*\{([^}]*)\}/)?.[2] || '';
  assert.match(html, /name="viewport" content="[^"]*viewport-fit=cover/);
  assert.match(body, /height:\s*100vh;\s*height:\s*100dvh;/);
  assert.match(body, /min-height:\s*100vh;\s*min-height:\s*100dvh;/);
  assert.match(body, /safe-area-inset-top/);
  assert.match(body, /safe-area-inset-bottom/);
  assert.match(display, /\.disp-main\s*\{[^}]*flex:\s*1;/s);
  assert.match(display, /\.disp-main\s*\{[^}]*min-height:\s*0;/s);
  assert.match(display, /\.disp-main\s*\{[^}]*overflow-y:\s*auto;/s);
});


test('super admin mobile chrome and sidebar respect safe dynamic viewport', () => {
  const superCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'super.css'), 'utf8');
  const superHtml = fs.readFileSync(path.join(__dirname, '..', 'super.html'), 'utf8');
  assert.match(superHtml, /name="viewport" content="[^"]*viewport-fit=cover/);
  const mobileRules = superCss.slice(superCss.lastIndexOf('Super-admin mobile chrome'));
  assert.match(mobileRules, /\.sidebar\s*\{[^}]*height:\s*calc\(100vh - 48px - env\(safe-area-inset-top, 0px\)\);\s*height:\s*calc\(100dvh - 48px - env\(safe-area-inset-top, 0px\)\);/s);
  assert.match(mobileRules, /\.sidebar\s*\{[^}]*height:\s*calc\(100vh - 44px - env\(safe-area-inset-top, 0px\)\);\s*height:\s*calc\(100dvh - 44px - env\(safe-area-inset-top, 0px\)\);/s);
  assert.match(mobileRules, /\.super-top\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top, 0px\)/s);
  assert.match(mobileRules, /\.mobile-menu-btn\s*\{[^}]*top:\s*calc\(5px \+ env\(safe-area-inset-top, 0px\)\)/s);
});


test('super admin standard and error dialogs stay scrollable inside the dynamic safe viewport', () => {
  const superCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'super.css'), 'utf8');
  const dialogRules = superCss.slice(superCss.lastIndexOf('Super-admin dialogs:'));
  const standardOverlay = dialogRules.match(/\.modal\s*\{([^}]*)\}/)?.[1] || '';
  const standardCard = dialogRules.match(/\.modal-card\s*\{([^}]*)\}/)?.[1] || '';
  const errorOverlay = dialogRules.match(/\.error-modal\s*\{([^}]*)\}/)?.[1] || '';
  const errorCard = dialogRules.match(/\.error-modal-card\s*\{([^}]*)\}/)?.[1] || '';
  for (const overlay of [standardOverlay, errorOverlay]) {
    assert.match(overlay, /overflow-y:\s*auto/);
    assert.match(overlay, /safe-area-inset-top/);
    assert.match(overlay, /safe-area-inset-bottom/);
    assert.match(overlay, /box-sizing:\s*border-box/);
  }
  for (const card of [standardCard, errorCard]) {
    assert.match(card, /max-height:\s*calc\(100vh/);
    assert.match(card, /overflow-y:\s*auto/);
    assert.match(card, /min-height:\s*0/);
    assert.match(card, /box-sizing:\s*border-box/);
  }
  assert.match(dialogRules, /@supports \(height:\s*100dvh\)/);
  assert.match(dialogRules, /max-height:\s*calc\(100dvh/);
  assert.match(dialogRules, /max-height:\s*calc\(85dvh/);
});


test('delivery admin page respects all device safe-area insets', () => {
  const deliveryAdmin = fs.readFileSync(path.join(__dirname, '..', 'admin-delivery.html'), 'utf8');
  const viewport = deliveryAdmin.match(/<meta name="viewport" content="([^"]+)"/)?.[1] || '';
  const main = deliveryAdmin.split('<style>')[1]?.split('</style>')[0] || '';
  assert.match(viewport, /viewport-fit=cover/);
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    assert.match(main, new RegExp('safe-area-inset-' + edge));
  }
});


test('admin, login and QR print pages opt into device safe-area viewport insets', () => {
  const cases = [
    ['admin.html', /name="viewport" content="[^"]*viewport-fit=cover/],
    ['login.html', /name="viewport" content="[^"]*viewport-fit=cover/],
    ['views/qr-print.html', /name="viewport" content="[^"]*viewport-fit=cover/]
  ];
  for (const [file, pattern] of cases) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(html, pattern, file + ' must enable viewport-fit=cover');
  }
});

test('admin mobile sidebar stays aligned below the header at every narrow breakpoint', () => {
  const adminCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  const marker = 'Keep the mobile admin sidebar directly below the header';
  const finalOverrides = adminCss.slice(adminCss.lastIndexOf(marker));
  const breakpoints = [
    ['920px', '58px'],
    ['760px', '56px'],
    ['480px', '52px'],
    ['420px', '48px'],
  ];

  let previous = -1;
  for (const [breakpoint, offset] of breakpoints) {
    const media = finalOverrides.indexOf(`@media (max-width: ${breakpoint})`);
    assert.ok(media > previous, `${breakpoint} sidebar override must follow the wider breakpoint`);
    const nextMedia = finalOverrides.indexOf('@media (max-width:', media + 1);
    const block = finalOverrides.slice(media, nextMedia === -1 ? undefined : nextMedia);
    if (breakpoint === '420px') {
      assert.doesNotMatch(block, /\\.ff-admin \\.top\\s*\\{/,
        'the 420px header height should be inherited from the preceding narrow-phone block');
      const narrowMarker = adminCss.lastIndexOf('Keep narrow-phone overrides after all legacy 480px rules.');
      const sidebarMarker = adminCss.lastIndexOf(marker);
      const narrowBlock = adminCss.slice(narrowMarker, sidebarMarker);
      assert.match(narrowBlock, new RegExp(`\\.ff-admin \\.top\\s*\\{[^}]*height:\\s*${offset};[^}]*min-height:\\s*${offset};`, 's'));
    } else {
      assert.match(block, new RegExp(`\\.ff-admin \\.top\\s*\\{[^}]*height:\\s*${offset};[^}]*min-height:\\s*${offset};`, 's'));
    }
    assert.match(block, new RegExp(`\\.ff-admin \\.admin-sidebar\\s*\\{[^}]*top:\\s*${offset};[^}]*height:\\s*calc\\(100vh - ${offset}\\);[^}]*height:\\s*calc\\(100dvh - ${offset}\\);`, 's'));
    previous = media;
  }
});


test('cashier refund amount input uses one consolidated overflow-safe rule', () => {
  const cashierCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'cashier.css'), 'utf8');
  const rules = cashierCss.match(/\.refund-input\s*\{[^}]*\}/g) || [];
  assert.equal(rules.length, 1, 'refund amount input must not be split across competing duplicate rules');
  const rule = rules[0];
  assert.match(rule, /height:\s*42px/);
  assert.match(rule, /min-width:\s*0/);
  assert.match(rule, /box-sizing:\s*border-box/);
  assert.match(rule, /font-size:\s*14px/);
  assert.match(rule, /font-weight:\s*700/);
  assert.match(rule, /padding:\s*10px 12px/);
});


test('cashier refund note textarea uses one consolidated cascade rule', () => {
  const cashierCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'cashier.css'), 'utf8');
  const rules = cashierCss.match(/^\.refund-textarea\s*\{[^}]*\}/gm) || [];
  assert.equal(rules.length, 1, 'refund note textarea must have one consolidated base rule');
  const rule = rules[0];
  assert.match(rule, /width:\s*100%/);
  assert.match(rule, /flex:\s*1/);
  assert.match(rule, /min-height:\s*80px/);
  assert.match(rule, /resize:\s*vertical/);
  assert.match(rule, /box-sizing:\s*border-box/);
  assert.match(rule, /border:\s*1\.5px solid var\(--pos-border\)/);
  assert.match(rule, /color:\s*var\(--pos-text\)/);
});


test('cashier refund select and textarea focus styles avoid duplicate base rules', () => {
  const cashierCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'cashier.css'), 'utf8');
  const selectRules = cashierCss.match(/\.refund-select\s*\{[^}]*\}/g) || [];
  assert.equal(selectRules.length, 1, 'refund select must use one consolidated base rule');
  assert.match(selectRules[0], /height:\s*44px/);
  assert.match(selectRules[0], /cursor:\s*pointer/);
  const textareaFocusRules = cashierCss.match(/\.refund-textarea:focus\s*\{/g) || [];
  assert.equal(textareaFocusRules.length, 1, 'refund textarea focus styling must be declared once');
});

test('cashier payment method logo uses one complete image rule', () => {
  const cashierCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'cashier.css'), 'utf8');
  const imageRules = cashierCss.match(/\.pos-tag\.pay-method img\s*\{[^}]*\}/g) || [];
  assert.equal(imageRules.length, 1, 'payment method logo image must not have duplicate rules');
  assert.match(imageRules[0], /display:\s*inline-block/);
  assert.match(imageRules[0], /vertical-align:\s*middle/);
  assert.match(imageRules[0], /flex-shrink:\s*0/);
});


test('cashier mobile order list and footer styles avoid redundant same-breakpoint rules', () => {
  const cashierCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'cashier.css'), 'utf8');
  const bottomBarRules = cashierCss.match(/\.pos-left \.pos-left-bottom\s*\{/g) || [];
  assert.equal(bottomBarRules.length, 1, 'mobile bottom statistics bar must have one consolidated rule');
  const orderListRules = cashierCss.match(/\.pos-order-list\s*\{/g) || [];
  assert.equal(orderListRules.length, 2, 'order list must have one base rule and one mobile override');
  const orderCardRules = cashierCss.match(/\.pos-order-card\s*\{/g) || [];
  assert.equal(orderCardRules.length, 2, 'order card must keep one base rule and one mobile override');
  const orderCardTagRules = cashierCss.match(/\.pos-order-card-tags\s*\{/g) || [];
  assert.equal(orderCardTagRules.length, 1, 'order card tag container must use one complete base rule');
  assert.match(cashierCss, /\.pos-order-card-tags\s*\{[^}]*margin-top:\s*8px;[^}]*width:\s*100%;/);
  assert.match(cashierCss, /\.pos-order-list\s*\{[^}]*padding:\s*10px 12px 12px;[^}]*-webkit-overflow-scrolling:\s*touch;[^}]*overscroll-behavior:\s*contain;/);
  assert.match(cashierCss, /\.pos-order-card\s*\{[^}]*padding:\s*11px 12px;[^}]*margin-bottom:\s*8px;/);
  assert.match(cashierCss, /\.pos-left \.pos-left-bottom\s*\{[^}]*margin-top:\s*auto;[^}]*flex-shrink:\s*0;[^}]*padding:\s*8px 0;/);
});

test('admin extracted responsive styles do not repeat the legacy 1024px and 480px overrides', () => {
  const adminCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  const extracted = adminCss.slice(adminCss.indexOf('Extracted from admin.html on 2026-09-28'));
  const repeated1024Rules = [
    /\.top #adminHeaderTitle\s*\{/,
    /\.sidebar-brand\s*\{[^}]*padding:\s*4px 4px 6px !important/s,
    /\.sidebar-store-icon\s*\{[^}]*font-size:\s*18px !important/s,
    /\.nav-item:hover\s*\{[^}]*background:\s*rgba\(255,255,255,.1\)/s
  ];
  for (const pattern of repeated1024Rules) {
    assert.doesNotMatch(extracted, pattern, 'extracted 1024px block must not duplicate the legacy responsive block');
  }
  const narrowRules = [
    /\.top\s*\{\s*padding:\s*0 8px 0 48px;\s*gap:\s*6px;\s*height:\s*52px;\s*min-height:\s*52px;/,
    /\.admin-sidebar\s*\{\s*padding:\s*14px 8px 8px !important;/,
    /\.nav-item\s*\{\s*padding:\s*10px;\s*font-size:\s*13px;\s*gap:\s*8px;/,
    /\.admin-shell\s*\{\s*padding:\s*8px 8px 16px;/
  ];
  for (const pattern of narrowRules) {
    assert.doesNotMatch(extracted, pattern, 'extracted 480px block must not duplicate the legacy narrow-screen rules');
  }
  assert.match(extracted, /\.tab-group\s*\{/, 'unique extracted tab-group styles must remain');
  assert.match(extracted, /\.menu-thumb img\s*\{/, 'unique extracted menu thumbnail styles must remain');
});


test('super admin responsive CSS avoids repeated declarations already inherited from wider breakpoints', () => {
  const superCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'super.css'), 'utf8');
  const statusBadgeRules = superCss.match(/\.data-table \.status-badge\s*\{[^}]*\}/g) || [];
  assert.equal(statusBadgeRules.length, 1, 'status badge sizing should be inherited from the 1024px rule');
  const repeatedFormSpacing = superCss.match(/\.form-group\s*\{\s*margin-bottom:\s*14px;\s*\}/g) || [];
  assert.equal(repeatedFormSpacing.length, 1, '14px form spacing should be declared once at the wider mobile breakpoint');
  const safeAreaMenuOffsets = superCss.match(/\.mobile-menu-btn\s*\{\s*top:\s*calc\(5px \+ env\(safe-area-inset-top, 0px\)\);\s*\}/g) || [];
  assert.equal(safeAreaMenuOffsets.length, 1, 'the narrower safe-area breakpoint should inherit the same menu-button offset');
  const safeAreaNarrow = superCss.slice(superCss.indexOf('@media (max-width: 768px) {', superCss.indexOf('Super-admin mobile chrome')));
  assert.match(safeAreaNarrow, /\.sidebar\s*\{[^}]*top:\s*calc\(44px \+ env\(safe-area-inset-top, 0px\)\)/s);
  assert.match(safeAreaNarrow, /\.main\s*\{[^}]*padding-top:\s*calc\(52px \+ env\(safe-area-inset-top, 0px\)\)/s);
});


test('super admin responsive modal inherits its base overlay background and card border', () => {
  const superCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'super.css'), 'utf8');
  const responsiveStart = superCss.indexOf('@media (max-width: 1024px) {');
  const responsiveEnd = superCss.indexOf('\n}\n', responsiveStart);
  assert.ok(responsiveStart >= 0 && responsiveEnd > responsiveStart);
  const responsive = superCss.slice(responsiveStart, responsiveEnd);
  const modalRule = responsive.match(/\.modal\s*\{([^}]*)\}/)?.[1] || '';
  const cardRule = responsive.match(/\.modal-card\s*\{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(modalRule, /background\s*:/, 'modal overlay must inherit the single base background');
  assert.doesNotMatch(cardRule, /border\s*:/, 'modal card must inherit the single base border');
  const baseModal = superCss.slice(0, responsiveStart);
  assert.match(baseModal, /\.modal\s*\{[^}]*background:\s*rgba\(0,0,0,.6\)/s);
  assert.match(baseModal, /\.modal-card\s*\{[^}]*border:\s*1px solid rgba\(255,255,255,.1\)/s);
});


test('merchant admin hamburger remains visible after legacy extracted CSS on mobile', () => {
  const adminCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  const finalRuleMarker = 'Keep the merchant-admin mobile navigation control visible after all legacy CSS.';
  const finalRuleIndex = adminCss.lastIndexOf(finalRuleMarker);
  const legacyHiddenRuleIndex = adminCss.lastIndexOf('.hamburger-btn { display: none');

  assert.ok(finalRuleIndex > legacyHiddenRuleIndex, 'the final mobile visibility override must follow the legacy hidden rule');
  const finalRules = adminCss.slice(finalRuleIndex);
  assert.match(finalRules, /@media\s*\(max-width:\s*1024px\)[\s\S]*body\.ff-admin\s+#hamburgerBtn\.hamburger-btn\s*\{[^}]*display:\s*flex;/);
  assert.match(finalRules, /body\.ff-admin\s+#hamburgerBtn\.hamburger-btn\s*\{[^}]*z-index:\s*1000;/);
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  assert.match(adminHtml, /<button[^>]*class="hamburger-btn"[^>]*id="hamburgerBtn"[^>]*onclick="toggleSidebar\(\)"/);
});


test('merchant admin responsive CSS does not repeat identical declarations at the same breakpoint', () => {
  const adminCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  const responsiveMarker = '/* ===== 响应式断点（按宽度从大到小排序，小屏覆盖大屏） ===== */';
  const responsiveStart = adminCss.indexOf(responsiveMarker);
  const responsiveEnd = adminCss.indexOf('@media (max-width: 920px)', responsiveStart);
  assert.ok(responsiveStart >= 0 && responsiveEnd > responsiveStart);
  const extracted1024 = adminCss.slice(responsiveStart, responsiveEnd);
  assert.equal((extracted1024.match(/\.admin-modules\s*\{[^}]*margin-left:\s*0 !important;[^}]*\}/g) || []).length, 1,
    'the 1024px admin-modules margin reset should be declared once');

  const narrowStart = adminCss.indexOf('/* Keep narrow-phone overrides after all legacy 480px rules. */');
  const sidebarAlignmentStart = adminCss.indexOf('/* Keep the mobile admin sidebar directly below the header', narrowStart);
  assert.ok(narrowStart >= 0 && sidebarAlignmentStart > narrowStart);
  const narrowOverrides = adminCss.slice(narrowStart, sidebarAlignmentStart);
  const narrowTopRule = narrowOverrides.match(/\.ff-admin \.top\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(narrowTopRule, /height:\s*48px;[\s\S]*min-height:\s*48px;/,
    'the narrow-phone layout block should own the 420px header height');
  const finalAlignment = adminCss.slice(sidebarAlignmentStart);
  const final420 = finalAlignment.slice(finalAlignment.indexOf('@media (max-width: 420px)'));
  assert.doesNotMatch(final420, /\.ff-admin \.top\s*\{/,
    'the final sidebar alignment block should not repeat the 420px header height');
});


test('customer menu cards and header remain viewport-contained on mobile', () => {
  const customer = fs.readFileSync(path.join(__dirname, '..', 'assets', 'customer.css'), 'utf8');
  const marker = '2026-11-24: fix customer ordering header/card width';
  const rules = customer.slice(customer.lastIndexOf(marker));
  assert.match(rules, /\.ff-customer \.header\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;/s);
  assert.match(rules, /\.ff-customer \.menu-grid\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(rules, /\.ff-customer \.menu-item\s*\{[^}]*min-width:\s*0;/s);
});

test('admin order action buttons shrink and wrap without viewport overflow on mobile', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  const marker = '2026-11-24: mobile order-list cards and actions';
  const rules = admin.slice(admin.lastIndexOf(marker));
  assert.match(rules, /#orders \.order-item-admin\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
  assert.match(rules, /#orders \.order-item-admin \.bottom \.actions button\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;/s);
});


test('super-admin merchant action buttons wrap on narrow viewports', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'super.css'), 'utf8');
  const marker = '2026-11-25 responsive audit: prevent merchant action rows';
  const rules = css.slice(css.lastIndexOf(marker));
  assert.match(rules, /@media \(max-width: 600px\)/);
  assert.match(rules, /\.merchant-actions\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(rules, /\.merchant-actions \.action-btn\s*\{[^}]*white-space:\s*normal;/s);
});

test('kitchen tickets and ticket headings adapt to narrow screens', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'kitchen.css'), 'utf8');
  const marker = '2026-11-25 responsive audit: kitchen tickets';
  const rules = css.slice(css.lastIndexOf(marker));
  assert.match(rules, /minmax\(min\(320px, 100%\), 1fr\)/);
  assert.match(rules, /\.ticket-head\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(rules, /@media \(max-width: 520px\)/);
});


test('admin order-list headers have a single polished responsive treatment after legacy rules', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  const marker = '2026-11-25: clearer administrator order-card headers';
  const rules = css.slice(css.lastIndexOf(marker));
  assert.match(rules, /\.ff-admin #orders \.order-item-admin \.top\s*\{[^}]*border-bottom:[^}]*background:/s);
  assert.match(rules, /\.ff-admin #orders \.order-item-admin \.top \.order-number\s*\{[^}]*background:/s);
  const mobileRules = rules.slice(rules.lastIndexOf('@media (max-width: 768px)'));
  assert.match(mobileRules, /\.ff-admin #orders \.order-item-admin \.top\s*\{[^}]*display:\s*flex\s*!important;[^}]*flex-wrap:\s*nowrap\s*!important;/s);
  assert.match(mobileRules, /\.ff-admin #orders \.order-item-admin \.top \.status\s*\{[^}]*flex:\s*0 0 auto\s*!important;[^}]*white-space:\s*nowrap\s*!important;/s);
  assert.match(mobileRules, /@media \(max-width: 420px\)/);
  assert.doesNotMatch(mobileRules, /grid-template-columns/);
});

test('admin settlement payment selector and cash input have scoped non-overlapping styles', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  assert.match(css, /\.settle-payment-field,[\s\S]*\.settle-cash-field\s*\{[^}]*display:\s*grid;/);
  assert.match(css, /\.settle-payment-select\s*\{[^}]*min-height:\s*44px;[^}]*box-sizing:\s*border-box;/s);
});


test('waiter table grid, bill rows, and header fit compact phone widths', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'waiter.css'), 'utf8');
  const marker = '2026-11-25 responsive audit: waiter table cards';
  const rules = css.slice(css.lastIndexOf(marker));
  assert.match(rules, /@media \(max-width: 480px\)/);
  assert.match(rules, /\.table-grid\s*\{[^}]*min\(260px, 100%\)/s);
  assert.match(rules, /\.bill-items \.line\s*\{[^}]*minmax\(0, 1fr\)/s);
  assert.match(rules, /header\s*\{[^}]*flex-wrap:\s*wrap;/s);
});


test('administrator cash received field remains hidden until cash is selected', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  assert.match(css, /\.settle-cash-field\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});


test('cashier payment and refund controls wrap and stay within narrow screens', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'cashier.css'), 'utf8');
  const marker = '2026-11-25 responsive audit: cashier payment and refund controls';
  const rules = css.slice(css.lastIndexOf(marker));
  assert.match(rules, /#paymentModal \.payment-methods\s*\{[^}]*grid-template-columns:[^}]*min\(88px, 100%\)/s);
  assert.match(rules, /#refundModal \.refund-select,[\s\S]*?min-width:\s*0;/);
  assert.match(rules, /#refundModal \.payment-actions \.btn[\s\S]*?flex:\s*1 1 120px;/);
  assert.match(rules, /@media \(max-width: 420px\)/);
});


test('shared KHQR modal content and action buttons remain contained on compact phones', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'khqr-shared.css'), 'utf8');
  const cashierHtml = fs.readFileSync(path.join(__dirname, '..', 'cashier.html'), 'utf8');
  const waiterHtml = fs.readFileSync(path.join(__dirname, '..', 'waiter.html'), 'utf8');
  assert.ok(cashierHtml.includes('assets/khqr-shared.css'));
  assert.ok(waiterHtml.includes('assets/khqr-shared.css'));
  assert.match(css, /#khqrModal \.khqr-image-wrap\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(css, /#khqrModal \.khqr-payee-account\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /#khqrModal \.payment-actions \.btn\s*\{[^}]*flex:\s*1 1 130px;/s);
});

test('mobile CSS fixes are served with refreshed cache-busting versions', () => {
  const customerHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const cashierHtml = fs.readFileSync(path.join(__dirname, '..', 'cashier.html'), 'utf8');
  const waiterHtml = fs.readFileSync(path.join(__dirname, '..', 'waiter.html'), 'utf8');
  assert.ok(customerHtml.includes('assets/customer.css?v=2026112501'));
  assert.ok(adminHtml.includes('assets/admin.css?v=2026112504'));
  assert.match(adminHtml, /assets\\/admin-bundle\\.js\\?v=\\d+/);
  assert.ok(cashierHtml.includes('assets/khqr-shared.css?v=2026112502'));
  assert.ok(waiterHtml.includes('assets/khqr-shared.css?v=2026112502'));
});

test('delivery admin tables and action rows remain usable on narrow phones', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin-delivery.html'), 'utf8');
  assert.match(html, /\.table-scroll\s*\{[^}]*overflow-x:\s*auto;[^}]*-webkit-overflow-scrolling:\s*touch;/s);
  assert.match(html, /\.table-scroll table\s*\{\s*min-width:\s*480px;\s*\}/);
  assert.match(html, /\.top>\.row\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(html, /className='table-scroll'/);
  assert.match(html, /viewport-fit=cover/);
});

test('delivery rider and tracking pages respect mobile safe areas and compact heights', () => {
  const rider = fs.readFileSync(path.join(__dirname, '..', 'delivery-rider.html'), 'utf8');
  const tracking = fs.readFileSync(path.join(__dirname, '..', 'delivery-track.html'), 'utf8');
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    assert.match(rider, new RegExp('safe-area-inset-' + edge));
    assert.match(tracking, new RegExp('safe-area-inset-' + edge));
  }
  assert.match(rider, /@media\(max-width:380px\)/);
  assert.match(tracking, /clamp\(220px,42dvh,360px\)/);
});

test('admin order card header keeps order number, fulfillment context and status on one line', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  const marker = '2026-11-25: keep each admin order-card header on one compact, readable line';
  const rules = css.slice(css.lastIndexOf(marker));
  assert.match(rules, /\.top\s*\{[^}]*flex-wrap:\s*nowrap\s*!important;/s);
  assert.match(rules, /\.top \.order-heading\s*\{[^}]*flex-wrap:\s*nowrap\s*!important;/s);
  assert.match(rules, /\.top \.order-number\s*\{[^}]*text-overflow:\s*ellipsis\s*!important;/s);
  assert.match(rules, /\.top \.order-context\s*\{[^}]*white-space:\s*nowrap\s*!important;/s);
  assert.match(rules, /\.top \.status\s*\{[^}]*font-size:\s*clamp\(10px, 2\.7vw, 11px\)\s*!important;/s);
  assert.match(rules, /@media \(max-width: 420px\)/);
});


test('admin order card header keeps all metadata on one left-aligned line', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  const marker = '2026-11-25: modern metadata pills for admin order card headers (style B).';
  const rules = css.slice(css.lastIndexOf(marker));
  assert.match(rules, /\.top\s*\{[^}]*justify-content:\s*flex-start\s*!important;/s);
  assert.match(rules, /\.top \.order-heading\s*\{[^}]*flex:\s*0 1 auto\s*!important;/s);
  assert.match(rules, /\.top \.order-context\s*\{[^}]*max-width:/s);
  assert.match(rules, /\.top \.status\s*\{[^}]*margin-left:\s*0\s*!important;/s);
  assert.match(rules, /@media \(max-width: 420px\)/);
});


test('admin order card uses distinct modern type and table pills on one left-aligned line', () => {
  const adminCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin.css'), 'utf8');
  const orderSource = fs.readFileSync(path.join(__dirname, '..', 'pages', 'admin', 'order.js'), 'utf8');
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'assets', 'admin-bundle.js'), 'utf8');
  const marker = '2026-11-25: modern metadata pills for admin order card headers (style B).';
  const rules = adminCss.slice(adminCss.lastIndexOf(marker));
  for (const source of [orderSource, bundle]) {
    assert.match(source, /order-type-badge/);
    assert.match(source, /order-table-badge/);
    assert.match(source, /orderFulfillmentDineIn/);
  }
  assert.match(rules, /\.top\s*\{[^}]*justify-content:\s*flex-start\s*!important;/s);
  assert.match(rules, /\.top \.order-type-badge\s*\{/);
  assert.match(rules, /\.top \.order-table-badge\s*\{/);
  assert.match(rules, /\.top \.status\s*\{[^}]*margin-left:\s*0\s*!important;/s);
  assert.match(rules, /@media \(max-width: 420px\)/);
});


test("admin mobile order header never reverts to a grid that pushes status onto another row", () => {
  const adminCss = fs.readFileSync(path.join(__dirname, "..", "assets", "admin.css"), "utf8");
  assert.doesNotMatch(adminCss, /\.ff-admin #orders \.order-item-admin \.top\s*\{[^}]*display:\s*grid\s*!important/s);
  const mobileBlock = adminCss.slice(adminCss.lastIndexOf("enforce one-row admin order headers"));
  assert.match(mobileBlock, /\.ff-admin #orders \.order-item-admin \.top\s*\{[^}]*display:flex\s*!important;[^}]*flex-wrap:nowrap\s*!important/s);
  assert.match(mobileBlock, /\.ff-admin #orders \.order-item-admin \.top \.status\s*\{[^}]*flex:0 0 auto\s*!important/s);
});


test('delivery checkout cart labels wrap safely and respect the bottom safe area', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'delivery-order.html'), 'utf8');
  assert.match(html, /padding-bottom:max\(30px,env\(safe-area-inset-bottom,0px\)\)/);
  assert.match(html, /\.cart-line>span:first-child\{[^}]*overflow-wrap:anywhere/s);
  assert.match(html, /\.cart-line strong\{[^}]*white-space:normal;overflow-wrap:anywhere/s);
  assert.match(html, /@media\(max-width:390px\)[\s\S]*\.cart-line strong\{max-width:48%\}/);
});

test('kitchen ticket item names wrap without forcing mobile card overflow', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'kitchen.css'), 'utf8');
  assert.match(css, /\.item-row \.name\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/s);
});

test('cashier KHQR content and action buttons remain contained on compact phones', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'cashier.css'), 'utf8');
  const marker = '2026-11-25 responsive audit: KHQR payment content';
  const rules = css.slice(css.lastIndexOf(marker));
  assert.match(rules, /#khqrModal \.khqr-image-wrap\s*\{[^}]*overflow:\s*hidden;/s);
  assert.match(rules, /#khqrModal \.khqr-payee-account\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(rules, /@media \(max-width: 480px\)/);
  assert.match(rules, /#khqrModal \.payment-actions \.btn\s*\{[^}]*flex:\s*1 1 130px;/s);
});

test('menu display header wraps controls on narrow phone screens', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'menu-display.css'), 'utf8');
  const rules = css.slice(css.lastIndexOf('Keep menu display header controls'));
  assert.match(rules, /@media \(max-width: 480px\)/);
  assert.match(rules, /\.disp-header\s*\{[^}]*flex-wrap:\s*wrap;/s);
  assert.match(rules, /\.disp-header-right\s*\{[^}]*flex-wrap:\s*wrap;/s);
});
