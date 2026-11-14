# Telegram Business Notifications — Integration Map

Status: safe transport and message-formatting primitives added; transactional outbox, event hooks, recipient routing, and delivery worker are not implemented. No business notifications are active.

## Existing capability

- `server/services/telegram-bot.js` validates Bot tokens/chat IDs and sends a fixed test message.
- `routes/super.js` stores two global scopes (`client` and `admin`) in the shared `settings` table. The admin scope is not merchant-scoped.
- The current client scope has one global chat ID. It cannot identify or safely route messages to individual customers.
- No transactional notification outbox or delivery worker currently exists.

## Verified business transaction boundaries

| Event | Source | Transaction boundary |
|---|---|---|
| New order | `routes/orders.js`, order insert around lines 549–574 | Inside `withTransaction`; outbox insert must be in this transaction |
| Admin manual settlement | `routes/orders.js`, `status='done'` branch around lines 797–807 | Inside the route's transaction |
| Cashier batch settlement | `routes/cashier.js`, updates around lines 285–349 | Inside `withTransaction`; one event per settled order |
| KHQR/manual payment confirmation | `routes/admin-manage.js`, update around lines 1018–1070 | Inside `withTransaction` |
| Refund | `routes/cashier.js`, refund update and idempotency response around lines 601–700 | Inside `withTransaction`; enqueue only after refund state and idempotency response are saved |

The waiter KHQR notification at `routes/admin-manage.js` around lines 987–1015 is only a request to confirm payment. It is not proof of payment and must never trigger a paid/settled notification.

## Progress in this branch

- Added a bounded generic `sendTelegramMessage` transport while preserving the existing fixed test-message API.
- Added allowlisted plain-text templates for new-order, settlement, and refund event shapes. Customer tokens, notes, reasons, and other unlisted fields are ignored.
- Added unit tests for transport validation, response redaction, event allowlisting, amount validation, and control-character sanitization. These tests have not yet been run in a local checkout or CI.
- These primitives are not wired to business routes and do not send notifications.

## Required design before enabling delivery

1. Use a durable InnoDB outbox with a unique event key, tenant identifiers, event type, minimal structured payload, attempt count, next-attempt time, lease owner/expiry, delivered timestamp, and sanitized last error code.
2. Insert outbox rows in the same transaction as the business state change. Rollback must remove the notification row too.
3. A worker claims rows with an expiring lease, sends outside the transaction, marks delivered only after Telegram confirms success, retries with bounded exponential backoff, and leaves exhausted rows inspectable as dead letters.
4. Never put Bot tokens, customer bearer tokens, payment QR payloads, full customer details, refund notes, or raw provider responses in the outbox or logs.
5. The existing global admin Bot is super-admin scoped. It must not be reused as a tenant delivery channel unless the product explicitly defines and documents that system-wide visibility. Merchant notifications need merchant/store-owned recipient configuration and strict tenant checks.
6. Customer notifications require a separate one-time Telegram account binding flow. Bind a Telegram user/chat to a verified customer identity using a short-lived, single-use challenge; support revocation and re-binding. Do not send customer order details to the existing shared client Chat ID.
7. Telegram updates must be authenticated (webhook secret token or an equivalent verified mechanism), rate-limited, replay-safe, and tenant-independent until the binding is validated.
8. Feature flags must default off. Telegram outages must never roll back or delay order, settlement, or refund transactions.

## Required tests

- Outbox insert participates in the caller transaction and disappears on rollback.
- Duplicate business event delivery is prevented by a unique idempotency key.
- Lease expiry permits recovery after worker restart without concurrent duplicate claims.
- Retry/backoff and terminal dead-letter behavior are deterministic.
- Cross-merchant/store recipients cannot be selected or reached.
- Expired, replayed, revoked, or mismatched customer binding challenges are rejected.
- Unauthorized webhook updates cannot create or alter bindings.
- Error logs and API responses never contain Bot tokens, customer tokens, or raw Telegram responses.

## Acceptance gate

Do not enable business notifications or merge a delivery implementation until the outbox worker, tenant-owned recipient settings, customer binding, all transaction hooks, tests, and a staging end-to-end delivery proof are present.