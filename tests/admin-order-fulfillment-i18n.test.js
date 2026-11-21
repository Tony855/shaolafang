const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const keys = ["orderFulfillmentTypeLabel","orderNoTableForDelivery","orderFulfillmentDineIn","orderFulfillmentTakeaway","orderFulfillmentDelivery","orderDeliveryFieldsRequired","orderDeliveryCreatedWaitingRider","orderTrackingCopied","orderTrackingCopyManual"];
test('order fulfillment translation keys exist in all locales', () => {
  for (const lang of ['zh','en','vi','th','km']) {
    const dict = JSON.parse(fs.readFileSync(path.join(root,'locales',lang+'.json'),'utf8'));
    for (const key of keys) assert.equal(typeof dict[key], 'string', lang+': '+key);
    for (const key of keys) assert.ok(dict[key].trim(), lang+': empty '+key);
  }
});
test('order admin page uses localized fulfillment prompts', () => {
  const page = fs.readFileSync(path.join(root,'pages/admin/order.js'),'utf8');
  for (const key of keys) assert.ok(page.includes("tAdmin('"+key+"')"), key);
});
