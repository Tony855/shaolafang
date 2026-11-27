'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const tableKeys = [
  'tableQrPopupBlocked',
  'tableAdminSessionExpired',
  'tableQrPageLoadFailed',
  'adminNoActiveStores',
  'adminStoreAccessRequired'
];
const orderKeys = [
  'orderFulfillmentTypeLabel',
  'orderNoTableForDelivery',
  'orderFulfillmentDineIn',
  'orderFulfillmentTakeaway',
  'orderFulfillmentDelivery',
  'orderDeliveryFieldsRequired',
  'orderDeliveryCreatedWaitingRider',
  'orderTrackingCopied',
  'orderTrackingCopyManual'
];
const allKeys = [...tableKeys, ...orderKeys];

test('admin table and order translations exist in all five locales', () => {
  for (const locale of ['zh', 'en', 'vi', 'th', 'km']) {
    const dictionary = JSON.parse(fs.readFileSync(path.join(root, 'locales', locale + '.json'), 'utf8'));
    for (const key of allKeys) {
      assert.equal(typeof dictionary[key], 'string', locale + ' missing ' + key);
      assert.ok(dictionary[key].trim(), locale + ' has empty ' + key);
    }
  }
});

test('table QR and admin store-access messages use translation keys', () => {
  const tablePage = fs.readFileSync(path.join(root, 'pages', 'admin', 'table.js'), 'utf8');
  const adminManager = fs.readFileSync(path.join(root, 'pages', 'admin', 'admin-mgr.js'), 'utf8');

  for (const key of ['tableQrPopupBlocked', 'tableAdminSessionExpired', 'tableQrPageLoadFailed']) {
    assert.ok(tablePage.includes("tAdmin('" + key + "')"), key);
  }
  assert.ok(adminManager.includes("tAdmin('adminNoActiveStores')"));
  assert.equal((adminManager.match(/tAdmin\('adminStoreAccessRequired'\)/g) || []).length, 2);
});

test('order fulfillment prompts and tracking feedback use translation keys', () => {
  const orderPage = fs.readFileSync(path.join(root, 'pages', 'admin', 'order.js'), 'utf8');
  for (const key of orderKeys) {
    assert.ok(orderPage.includes("tAdmin('" + key + "')"), key);
  }
});

test('generated admin and language bundles include the localized source keys', () => {
  assert.match(adminHtml, /assets\/admin-bundle\.js\?v=\d+/);
  const languageSource = fs.readFileSync(path.join(root, 'languages.js'), 'utf8');
  const languageMin = fs.readFileSync(path.join(root, 'languages.min.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

  for (const key of allKeys) {
    assert.ok(bundle.includes(key), 'admin bundle missing ' + key);
    assert.ok(languageSource.includes(key), 'languages.js missing ' + key);
    assert.ok(languageMin.includes(key), 'languages.min.js missing ' + key);
  }
  assert.match(adminHtml, /languages\.min\.js\?v=2026112501/);
  assert.match(adminHtml, /assets\/admin-bundle\.js\?v=2026112504/);
});
