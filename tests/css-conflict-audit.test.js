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
  const final420 = adminCss.lastIndexOf('@media (max-width: 420px)');
  const final480 = adminCss.lastIndexOf('@media (max-width: 480px)');
  assert.ok(final420 > final480, 'the final narrow-phone overrides must follow all 480px rules');
  const narrowCss = adminCss.slice(final420);
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
  const main = deliveryAdmin.match(/main\\s*\\{([^}]*)\\}/)?.[1] || '';
  assert.match(viewport, /viewport-fit=cover/);
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    assert.match(main, new RegExp('safe-area-inset-' + edge));
  }
});
