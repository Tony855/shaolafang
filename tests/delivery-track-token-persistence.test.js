'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const track = fs.readFileSync(path.join(__dirname, '..', 'delivery-track.html'), 'utf8');
const order = fs.readFileSync(path.join(__dirname, '..', 'delivery-order.html'), 'utf8');

test('delivery tracking restores the per-order customer credential after a Telegram Mini App reopen', () => {
  assert.ok(track.includes("saveStoredToken('localStorage','customer_token:'+orderId,customerToken)"));
  assert.ok(track.includes("readStoredToken('localStorage','customer_token:'+orderId)"));
  assert.ok(track.includes("readStoredToken('localStorage','foodflow_customer_identity_v1')"));
  assert.ok(order.includes("localStorage.setItem('customer_token:'+data.orderId,data.customerToken)"));
});

test('delivery tracking keeps a valid URL-fragment credential in memory when browser storage fails', () => {
  assert.match(track, /let customerToken=isCustomerToken\(fragmentToken\)\?fragmentToken:''/);
  assert.match(track, /function saveStoredToken\(storageName,key,value\)\{try\{window\[storageName\]\.setItem\(key,value\);return true;\}catch\(_\)\{return false;\}\}/);
  assert.match(track, /function readStoredToken\(storageName,key\)\{try\{return window\[storageName\]\.getItem\(key\)\|\|'';\}catch\(_\)\{return '';\}\}/);
});

test('delivery tracking rejects malformed customer credentials before making an API request', () => {
  assert.match(track, /const isCustomerToken=value=>typeof value==='string'&&\/\^\[a-f0-9\]\{64\}\$\//);
  assert.match(track, /storedTokens\.find\(isCustomerToken\)\|\|''/);
});


test('delivery tracking bounds API response and JSON body reads with a timeout', () => {
  assert.ok(track.includes('const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000)'));
  assert.ok(track.includes('response.json=async(...args)=>{try{return await readJson(...args);}finally{clearTimer();}}'));
  assert.ok(track.includes("fetchWithTimeout('/api/public/delivery/'+encodeURIComponent(orderId)"));
  assert.ok(track.includes('catch(error){clearTimer();throw error;}'));
});
