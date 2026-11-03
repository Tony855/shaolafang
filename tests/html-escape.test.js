'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, jsonForScript } = require('../server/utils/html');

test('HTML escaping protects text and attribute contexts', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)> & "quoted"'), '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;');
  assert.equal(escapeHtml("O'Reilly"), 'O&#39;Reilly');
});

test('inline script JSON escapes script-closing and HTML-significant characters', () => {
  const encoded = jsonForScript('</script><script>alert(1)</script>');
  assert.ok(!encoded.includes('<'));
  assert.ok(!encoded.includes('>'));
  assert.ok(encoded.includes('\\u003c/script\\u003e'));
});
