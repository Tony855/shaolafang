'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { constantTimeSecretMatch, parseTelegramPrivateStartUpdate } = require('../server/services/telegram-webhook');

const challenge = 'A'.repeat(43);

test('Telegram webhook secret comparison rejects missing and mismatched secrets', () => {
  assert.equal(constantTimeSecretMatch('secret-token', 'secret-token'), true);
  assert.equal(constantTimeSecretMatch('secret-token', 'other-token'), false);
  assert.equal(constantTimeSecretMatch('', 'secret-token'), false);
  assert.equal(constantTimeSecretMatch('secret-token', ''), false);
});

test('Telegram binding accepts only private /start messages with bounded payloads', () => {
  const update = { update_id: 123, message: { text: `/start ${challenge}`, chat: { id: 98765, type: 'private' }, from: { id: 98765, is_bot: false } } };
  assert.deepEqual(parseTelegramPrivateStartUpdate(update), { updateId: 123, challenge, telegramUserId: '98765', telegramChatId: '98765' });
  assert.equal(parseTelegramPrivateStartUpdate({ ...update, message: { ...update.message, chat: { id: -100, type: 'group' } } }), null);
  assert.equal(parseTelegramPrivateStartUpdate({ ...update, message: { ...update.message, text: 'hello' } }), null);
  assert.equal(parseTelegramPrivateStartUpdate({ ...update, update_id: Number.MAX_SAFE_INTEGER + 1 }), null);
  assert.equal(parseTelegramPrivateStartUpdate({ ...update, message: { ...update.message, from: { id: 1, is_bot: true } } }), null);
});
