# Telegram Business Notifications — Implementation Status

## Current status

The feature branch now contains the main implementation for global super-admin, per-store admin, and customer Telegram notifications. Business events are inserted into a durable InnoDB outbox in the same transaction as the order/payment/refund change. A separate opt-in worker performs delivery with leases, bounded retries, dead-letter handling, retention cleanup, and graceful shutdown.

**The worker is disabled by default.** No production notification delivery is active unless the deployment explicitly enables it. This branch has not been merged into `main` and has not been deployed.

Latest full CI run before this documentation update: **success** — repository validation, unit tests, MySQL 8.4 integration, and MariaDB 10.11/11.4/11.8/12.3 integration all passed in run [43585419361](https://github.com/Tony855/shaolafang/actions/runs/43585419361). The documentation-only update will trigger a fresh run.

## Notification scopes and routing

- **Global super-admin:** the existing global Admin Bot configuration and global Chat ID remain available for system-wide notices.
- **Store admin:** each active merchant/store can configure its own Chat ID and event toggles in the Admin settings page. The delivery uses the globally configured Admin Bot token; it does not create a separate Bot token per merchant. Recipient lookup joins the recipient row to the exact active store and merchant before delivery.
- **Customer:** the existing global Client Bot token is used, but each customer's private Telegram chat is resolved through a one-time binding to the hashed customer-token identity and exact store. The shared Client Bot Chat ID is never used for personal order details.

The store-level Admin settings page is available at `/api/admin/telegram/notification-settings` and is restricted by the existing admin authentication, `can_manage_store` permission, merchant ID, and current store ID. It stores only the store Chat ID and event toggles; it does not expose either Bot token.

## Business event integration

| Event | Business entry point | Delivery |
|---|---|---|
| New order | `routes/orders.js` | Global admin (if enabled), exact store admin (if configured/enabled), and bound customer (if present) |
| Admin manual settlement | `routes/orders.js` | Global admin, exact store admin, and bound customer |
| Cashier single/batch settlement | `routes/cashier.js` | One event per settled order for global admin, exact store admin, and bound customer |
| Actual KHQR/manual payment confirmation | `routes/admin-manage.js` | Global admin, exact store admin, and bound customer |
| Successful refund | `routes/cashier.js` | Global admin, exact store admin, and bound customer |

All listed enqueue operations occur inside the existing business transaction. The waiter KHQR confirmation-request path is intentionally excluded: requesting a cashier to confirm a QR payment is not proof that payment succeeded.

The current refund route performs and records the refund in one transaction; there is no separate pending refund-approval state in that path. Therefore it emits a notification for the completed refund, not a fabricated intermediate “refund requested” event.

## Customer binding and webhook

- Customer binding start and revoke endpoints are registered in `routes/public-session.js`. They require both `X-Scan-Session` and `X-Customer-Token` headers; bearer values are not placed in URLs.
- The start endpoint verifies the active scan session/store, stores only a SHA-256 challenge hash, and returns a short-lived Telegram deep link. The challenge is single-use and expires.
- `routes/telegram-webhook.js` registers `POST /api/telegram/client/webhook`. It validates `X-Telegram-Bot-Api-Secret-Token` using a constant-time comparison, accepts only private-chat `/start` updates, records Telegram update IDs for replay protection, checks the active merchant/store, and binds only the matching customer identity.
- A customer can revoke a binding and can safely rebind the same owner. A chat already owned by another customer identity in that store is rejected.
- The deployment must set `TELEGRAM_CLIENT_WEBHOOK_SECRET` to a random 32–256 character secret and configure the Client Bot webhook URL to `https://<your-domain>/api/telegram/client/webhook` using Telegram's `setWebhook` API. Do not commit the Bot token or webhook secret.

## Outbox and worker behavior

- Schema migrations: `server/db/migrations/telegram-notification-outbox.js`, `telegram-customer-binding.js`, and `telegram-store-admin-recipients.js`; all are called during startup schema initialization.
- Event payloads are rendered through a strict event-type allowlist. The outbox stores the rendered message, not the original business object. Customer bearer tokens, notes, refund reasons, payment QR payloads, and raw Telegram responses are not copied into messages.
- Unique event keys make enqueue idempotent. The outbox uses InnoDB transactions, multi-worker `FOR UPDATE SKIP LOCKED` claims, 60-second leases, lease-owner checks, bounded exponential retries, and terminal dead-letter state.
- The worker runs one delivery at a time with a bounded Telegram request timeout. It is started only when `TELEGRAM_NOTIFICATION_WORKER_ENABLED=true`; the default is off. Graceful shutdown stops the worker before closing MySQL.
- Delivery is **at-least-once**. If Telegram accepts a message and the process crashes before the outbox acknowledgement, a retry after lease expiry may send a duplicate.
- Retention cleanup removes delivered history after 90 days and dead-letter history after 180 days. Telegram webhook update IDs are pruned after 30 days.

## Backup and restore

Backups now include the outbox, customer bindings, webhook update IDs, and store-admin recipient configuration. Ephemeral one-time customer binding challenges are exported as an empty table so a deep link cannot be replayed after restoring a backup. Older backups that predate these Telegram tables remain importable; the missing tables are restored empty.

## Operational enablement checklist

1. Configure and enable the global Admin Bot in Super Admin settings. Store-level Admin notifications use this Bot token.
2. In each store's Admin settings, enter the destination Chat ID, choose the event toggles, and enable that store's notifications. Add the Bot to the target Telegram group and grant it permission to send messages.
3. Configure and enable the global Client Bot in Super Admin settings if customer notifications are required.
4. Set `TELEGRAM_CLIENT_WEBHOOK_SECRET` and register the Client Bot webhook to the public endpoint described above.
5. Set `TELEGRAM_NOTIFICATION_WORKER_ENABLED=true` in the application environment, restart the application, and verify worker startup in logs.
6. Perform staging end-to-end tests for new order, settlement, KHQR confirmation, refund, customer binding/revocation, retry, worker restart, and cross-store isolation before enabling in production.

## Remaining acceptance work

- Staging end-to-end delivery proof and restart/lease-recovery soak testing are still required. CI success does not replace Telegram delivery verification against real test Bots and Chat IDs.
- Verify the production deployment environment has the webhook secret and worker flag configured before any rollout.
- Review dead-letter operational monitoring/alerting with the deployment operator.
- No PR has been opened, no changes have been merged to `main`, and no production deployment has been performed.
