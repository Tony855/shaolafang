# Telegram Business Notifications — Implementation Status

## Current status

The feature branch now contains the main implementation for global super-admin, per-store admin, and customer Telegram notifications. Business events are inserted into a durable InnoDB outbox in the same transaction as the order/payment/refund change. A separate opt-in worker performs delivery with leases, bounded retries, dead-letter handling, retention cleanup, and graceful shutdown.

**The worker is disabled by default.** No production notification delivery is active unless the deployment explicitly enables it.

The implementation is submitted as [draft PR #266](https://github.com/Tony855/shaolafang/pull/266), targeting `main`. Latest branch head: `71d72ed1f4954a1e63cca01e1d9aace6139211a4`. The PR currently reports a clean mergeable state.

CI passed on the PR head:
- [43589563092](https://github.com/Tony855/shaolafang/actions/runs/43588709221): Debian 12/13 and Ubuntu 22.04/24.04/26.04.
- [43589563047](https://github.com/Tony855/shaolafang/actions/runs/43588709172): repository validation, complete test suite, MySQL 8.4, and MariaDB 10.11/11.4/11.8/12.3.

CI success does not replace real Telegram staging acceptance. No live Bot token or webhook secret is stored in the repository, and no real Telegram delivery has been exercised in staging during this implementation. The PR remains draft and has not been merged or deployed.

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

## Bot setup and operational troubleshooting

### Bot commands and ownership

- Create the Client Bot and Admin Bot separately with Telegram's official BotFather. Keep their tokens independent; never paste tokens into issue comments, screenshots, chat messages, or committed environment files.
- The Client Bot is the only Bot customers should open. Customers start it using the one-time deep link generated from their active FoodFlow customer session. The bot accepts the private-chat `/start <one-time-challenge>` flow only; it does not accept arbitrary customer IDs or bearer tokens in Telegram commands.
- The Admin Bot is added to the target admin group. A super-admin configures its global destination in Super Admin settings; each store admin separately configures that store's group Chat ID and event toggles. A store does not receive its own Bot token.
- Do not configure the shared Client Bot Chat ID as a customer destination. Customer order notifications must resolve from an active, owner-checked binding.

### Register and inspect the Client Bot webhook

Set secrets in the deployment's protected environment, not in source control. Example shell commands use environment variables so the token is not embedded in a committed script:

```sh
export TELEGRAM_CLIENT_BOT_TOKEN='set-in-secret-manager'
export TELEGRAM_CLIENT_WEBHOOK_SECRET='set-a-random-32-to-256-character-secret'
export FOODFLOW_PUBLIC_URL='https://foodflow.example.com'

curl --fail-with-body -sS \
  "https://api.telegram.org/bot${TELEGRAM_CLIENT_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${FOODFLOW_PUBLIC_URL}/api/telegram/client/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_CLIENT_WEBHOOK_SECRET}"

curl --fail-with-body -sS \
  "https://api.telegram.org/bot${TELEGRAM_CLIENT_BOT_TOKEN}/getWebhookInfo"
```

The sample uses a placeholder domain; replace it with the actual HTTPS origin. Protect shell history and process/environment inspection on the deployment host. The webhook secret must exactly match `TELEGRAM_CLIENT_WEBHOOK_SECRET` in the running application. Do not publish the output of secret-bearing commands.

### Troubleshooting checklist

- **Webhook returns 401:** verify the reverse proxy preserves `X-Telegram-Bot-Api-Secret-Token` and the configured secret matches byte-for-byte. Do not log the header.
- **Webhook cannot be reached:** verify public HTTPS, certificate validity, reverse-proxy routing to `POST /api/telegram/client/webhook`, and that the application route is mounted.
- **Customer binding does not complete:** confirm the customer still has an active scan session, the one-time challenge has not expired or been consumed, and the Client Bot is enabled. Generate a fresh link rather than reusing an old one.
- **Admin group receives nothing:** verify the Admin Bot is enabled, is a member of the configured group, can send messages, the Chat ID is correct, and the store's relevant event toggle is on.
- **Customer receives nothing:** verify the Client Bot is enabled and the customer has an active binding for the same merchant and store as the order. The shared Client Bot Chat ID is not a fallback.
- **Messages remain pending or retry:** verify outbound HTTPS connectivity to `api.telegram.org`, Bot token validity, and the worker's opt-in environment flag. The business transaction does not wait for Telegram delivery.
- **Dead-letter entries:** inspect the safe `last_error_code` and attempt count using an authorized operational database session. Do not expose Bot tokens, webhook secrets, raw Telegram payloads, or customer bearer values in support logs.
- **Worker restart:** expired processing leases become eligible for reclaim after their lease deadline. Delivery is at-least-once, so the crash window after Telegram acceptance but before database acknowledgement can produce a duplicate.

The worker's safe log messages identify a failed cleanup or batch without printing raw exception text. Operational alerting for sustained pending/dead-letter growth should be configured by the deployment operator; CI cannot verify production alert delivery.

## Remaining acceptance work

- Staging end-to-end delivery proof and restart/lease-recovery soak testing are still required. CI success does not replace Telegram delivery verification against real test Bots and Chat IDs.
- Verify the production deployment environment has the webhook secret and worker flag configured before any rollout.
- Review dead-letter operational monitoring/alerting with the deployment operator.
- PR #266 remains a draft. No changes have been merged to `main`, and no production deployment has been performed.
