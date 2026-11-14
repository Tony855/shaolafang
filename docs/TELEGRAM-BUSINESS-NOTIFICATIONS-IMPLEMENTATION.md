# Telegram Business Notifications — Integration Map

Status: safe transport, message formatting, startup schema migration, transactional outbox, lease/retry primitives, and a dependency-injected batch processor are present. MySQL/MariaDB integration coverage is being added and CI is running against MySQL 8.4 and MariaDB 10.11/11.4/11.8/12.3. Business event hooks, merchant/customer recipient resolvers, webhook binding, merchant/customer routing, event hooks, and staging delivery remain unimplemented. A fail-closed resolver for the existing global super-admin Bot and an opt-in single-flight worker lifecycle are now implemented. The worker is disabled unless `TELEGRAM_NOTIFICATION_WORKER_ENABLED=true`. No business notifications are active.

## Existing capability

- `server/services/telegram-bot.js` validates Bot tokens/chat IDs and sends a fixed test message.
- `routes/super.js` stores two global scopes (`client` and `admin`) in the shared `settings` table. The admin scope is not merchant-scoped.
- The current client scope has one global chat ID. It cannot identify or safely route messages to individual customers.
- The new branch adds a dedicated idempotent schema migration (`server/db/migrations/telegram-notification-outbox.js`), called from startup schema initialization, plus queue claim/ack/retry helpers and a batch processor. The processor requires a caller-supplied recipient resolver; a fail-closed resolver exists only for the existing global admin Bot (`admin:primary`). It deliberately rejects customer and merchant/store scopes. The worker runtime is wired into application startup only when `TELEGRAM_NOTIFICATION_WORKER_ENABLED=true`; its default is off. Graceful shutdown stops the worker before closing MySQL. Its default batch size is one because each Telegram request has a bounded 10-second timeout and must complete within its lease.

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
- Added unit tests for transport validation, response redaction, event allowlisting, amount validation, and control-character sanitization. The unit tests passed in GitHub Actions on commit `04d7392`.
- Added `enqueueSystemAdminTelegramNotification`: it checks the existing global admin Bot enabled flag, stores only allowlisted rendered text, and uses the existing admin Chat ID scope. It never sends customer details to the shared client Bot Chat ID.
- Wired new-order creation, admin manual settlement, cashier single/batch settlement, actual KHQR/manual payment confirmation, and refund success to enqueue an admin-scope event inside each existing business transaction. The waiter KHQR confirmation-request path is deliberately not hooked.
- The feature branch can deliver these admin events only when both the admin Bot is enabled in Super Admin settings and `TELEGRAM_NOTIFICATION_WORKER_ENABLED=true`. The worker defaults off; `main` remains unchanged.
- Added an InnoDB outbox table with a unique event key, tenant scope, recipient reference, attempt counter, lease, retry timestamp, delivered timestamp, and fixed error-code field.
- Added `enqueueTelegramNotification`, which stores only a pre-rendered allowlisted message, so caller-provided customer tokens/notes are not copied into the outbox. It participates in the current `withTransaction` connection through `AsyncLocalStorage`.
- Added a multi-worker `FOR UPDATE SKIP LOCKED` claim path, lease ownership and non-expired lease checks, bounded exponential retry, and dead-letter handling, including exhausted jobs left behind by a crashed worker.
- Added a dependency-injected batch processor that checks resolved recipient scope and tenant IDs before sending. It is scheduled by `server.js` only when `TELEGRAM_NOTIFICATION_WORKER_ENABLED=true`; it defaults off. The default resolver can only resolve the explicitly enabled global admin Bot.
- Added tests for outbox payload minimization, tenant scope validation, retry schedule, recipient ownership checks, safe error classification, admin recipient resolution, enqueue gating, single-flight worker behavior, and graceful shutdown ordering. Full validation, repository tests, MySQL 8.4 integration, and MariaDB 10.11/11.4/11.8/12.3 integration all passed in CI run `43581080837` for commit `6e56bbc`.

## Required design before enabling delivery

1. Implement and review merchant/store and customer recipient resolvers. The only resolver currently available is system-admin-only and fails closed for every other scope. Merchant/store resolution must join and verify the active store belongs to the active merchant; customer resolution must validate an active, unrevoked Telegram binding for the same store.
2. Insert outbox rows in the same transaction as the business state change. Rollback must remove the notification row too.
3. Worker lifecycle is wired with single-flight polling, bounded send timeouts, opt-in startup, and graceful shutdown. Still required: staging soak/restart testing and operational alerting for dead letters.
4. Never put Bot tokens, customer bearer tokens, payment QR payloads, full customer details, refund notes, or raw provider responses in the outbox or logs.
5. The existing global admin Bot is super-admin scoped. It must not be reused as a tenant delivery channel unless the product explicitly defines and documents that system-wide visibility. Merchant notifications need merchant/store-owned recipient configuration and strict tenant checks.
6. Customer notifications require a separate one-time Telegram account binding flow. Bind a Telegram user/chat to a verified customer identity using a short-lived, single-use challenge; support revocation and re-binding. Do not send customer order details to the existing shared client Chat ID.
7. Telegram updates must be authenticated (webhook secret token or an equivalent verified mechanism), rate-limited, replay-safe, and tenant-independent until the binding is validated.
8. Feature flags must default off. Telegram outages must never roll back or delay order, settlement, or refund transactions.

## Required tests

- Added `tests/telegram-notification-recipient.test.js`, `tests/telegram-notification-enqueue.test.js`, and `tests/telegram-notification-worker-runtime.test.js`, plus graceful-shutdown ordering coverage. All passed in CI run `43581080837`.
- Added `tests/mysql-telegram-outbox-integration.test.js`: verifies repeatable schema creation, transaction rollback, idempotency, concurrent claim exclusion, lease-owner acknowledgement, expired-lease recovery, retry metadata, and batch delivery with a mocked Telegram sender. It passed on MySQL 8.4 and MariaDB 10.11/11.4/11.8/12.3 in CI run `43581080837`.
- Added unit tests for the system-admin recipient resolver; it is intentionally not allowed to resolve merchant or customer destinations.
- Outbox insert participates in the caller transaction and disappears on rollback.
- Duplicate business event delivery is prevented by a unique idempotency key.
- Lease expiry permits recovery after worker restart without concurrent duplicate claims.
- End-to-end worker tests verify that a failed recipient resolver never sends, and a Telegram success is only marked delivered by the current, non-expired lease owner.
- Document the delivery contract as at-least-once: a process crash after Telegram accepts a message but before the outbox ack may cause a duplicate on lease recovery.
- Retry/backoff and terminal dead-letter behavior are deterministic.
- Cross-merchant/store recipients cannot be selected or reached.
- Expired, replayed, revoked, or mismatched customer binding challenges are rejected.
- Unauthorized webhook updates cannot create or alter bindings.
- Error logs and API responses never contain Bot tokens, customer tokens, or raw Telegram responses.

## Acceptance gate

Do not merge the full client/merchant notification feature until tenant-owned recipient settings, customer binding/webhook, remaining event hooks, tests, and a staging end-to-end delivery proof are present. The current branch's global admin notification path is feature-flagged and is not deployed to `main`.