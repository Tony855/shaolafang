# Telegram Business Notifications — Implementation Status

## Current status

The Telegram business-notification implementation was merged into `main` through [PR #266](https://github.com/Tony855/shaolafang/pull/266). Business events are inserted into a durable InnoDB outbox in the same transaction as the order/payment/refund change. A separate opt-in worker performs delivery with leases, bounded retries, dead-letter handling, retention cleanup, and graceful shutdown.

**The worker is enabled by default in production.** Delivery still requires configured Bot profiles, recipients, and customer bindings. Set `TELEGRAM_NOTIFICATION_WORKER_ENABLED=false` only to intentionally pause delivery; enabling the worker alone does not create recipients or bind customers.

Automated CI and database integration coverage passed on the merged implementation. This does not replace live Telegram staging acceptance: dedicated test Bots, Chat IDs, multiple stores, QR rebind/revoke, worker restart, and backup/restore still need to be exercised before treating the feature as production-accepted.

## Notification scopes and routing

- **Global super-admin:** configures only the shared Admin Bot token and enabled state. The super-admin has no business-notification Chat ID and does not receive store business messages.
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
- `routes/telegram-webhook.js` registers `POST /api/telegram/client/webhook`. It validates `X-Telegram-Bot-Api-Secret-Token` using a constant-time comparison, accepts only private-chat `/start` and `/stop` updates, records Telegram update IDs for replay protection, checks the active merchant/store, and binds only the matching customer identity. Challenge expiry is decided by the UTC database predicate to avoid local-timezone interpretation of MySQL `DATETIME` values.
- A customer can revoke a binding from the FoodFlow page while the scan session is active, or send `/stop` to the Bot they use. On a tenant-owned Client Bot, `/stop` revokes only that merchant's active bindings; the legacy shared Bot revokes only bindings belonging to merchants that have not migrated. Both revocation paths atomically dead-letter queued/processing customer notices as `binding_revoked`; reactivating an old binding also dead-letters any pre-opt-out jobs, so a later rebind cannot release them. Because customer tokens rotate for each QR scan, a valid one-time challenge plus proof of control of the same private Telegram chat can move that chat to the current scan identity for that store. The old binding row is deleted so queued notifications for the previous identity fail closed; the worker terminally suppresses those stale jobs as `binding_revoked` instead of retrying them. Another store remains isolated.
- The deployment must set `TELEGRAM_CLIENT_WEBHOOK_SECRET` to a random 32–256 character secret and `FOODFLOW_PUBLIC_URL` to the public HTTPS origin. The super-admin save flow and startup synchronization configure the legacy shared Client Bot menu and `setWebhook` URL (`/api/telegram/client/webhook`) automatically. Tenant-owned Client Bots use a per-merchant path-token webhook and per-tenant secret; their configuration is managed in Merchant Admin. Do not commit the Bot token or webhook secret.

## Outbox and worker behavior

- Schema migrations: `server/db/migrations/telegram-notification-outbox.js`, `telegram-customer-binding.js`, and `telegram-store-admin-recipients.js`; all are called during startup schema initialization.
- Event payloads are rendered through a strict event-type allowlist. The outbox stores the rendered message, not the original business object. Customer bearer tokens, notes, refund reasons, payment QR payloads, and raw Telegram responses are not copied into messages.
- Unique event keys make enqueue idempotent. The outbox uses InnoDB transactions, multi-worker `FOR UPDATE SKIP LOCKED` claims, 60-second leases, lease-owner checks, bounded exponential retries, Telegram HTTP 429 `parameters.retry_after` handling capped at one hour, and terminal dead-letter state. Expired leases exhausted at eight attempts are swept in a bounded `SKIP LOCKED` cleanup transaction, not a broad pre-claim update that can deadlock concurrent workers.
- Enqueue serializes against Bot/store disable and customer opt-out with a stable row-lock order: both global Bot-enabled settings in sorted key order, merchant, store, binding/recipient, then outbox. Customer `/stop`, page revoke, store/merchant deletion, full reset, and backup restore lock challenge/binding rows before outbox cleanup. This prevents concurrent order transactions from inserting stale notifications after a disable/revoke has committed.
- Immediately before a customer task crosses from `processing` to `sending`, the worker locks and rechecks the exact active binding row in a transaction, then updates the outbox row. This uses the same binding → outbox lock order as `/stop` and page revoke: if revocation obtains the binding lock first, the task is dead-lettered and Telegram is not called; if the worker obtains it first, the task has crossed the send boundary and is treated as in-flight. A Telegram request already in flight cannot be recalled.
- The worker runs one delivery at a time with a bounded Telegram request timeout. It starts by default; set `TELEGRAM_NOTIFICATION_WORKER_ENABLED=false` to pause delivery. Graceful shutdown stops the worker before closing MySQL.
- Delivery is **at-least-once**. If Telegram accepts a message and the process crashes before the outbox acknowledgement, a retry after lease expiry may send a duplicate.
- Disabling the global Client Bot terminally dead-letters queued customer notices; disabling the global Admin Bot terminally dead-letters queued legacy system-admin and store-admin notices in the same settings transaction. Disabling a store or an individual store event toggle likewise dead-letters only that store's matching queued notices in the same transaction. Re-enabling a Bot, store, or event toggle cannot release that disabled-period backlog. A Telegram request already in flight cannot be recalled.
- Retention cleanup removes delivered history after 90 days and dead-letter history after 180 days. Telegram webhook update IDs are pruned after 30 days.

## Backup and restore

Backups include the outbox, customer-binding records, webhook update IDs, and store-admin recipient configuration. Ephemeral one-time challenges are exported as an empty table. Before restore, disable the Telegram worker on every application node and wait for in-flight sends to finish. The restore transaction also locks Bot settings, merchants, stores, challenges, and bindings before replacing data, then invalidates customer bindings before dead-lettering their queued notices. During restore, all customer bindings and challenges are deliberately invalidated because customer bearer tokens are redacted and scan sessions are cleared; pending/processing customer-scoped outbox jobs are moved to dead-letter with `invalid_recipient`. Customers must scan again and rebind Telegram. Admin/store notification settings and their queued jobs are retained. Older backups that predate these Telegram tables remain importable; missing tables are restored empty.

## Operational enablement checklist

1. Configure and enable the global Admin Bot in Super Admin settings. Store-level Admin notifications use this platform Bot token, while each destination Chat ID and event policy is isolated by the authenticated merchant/store pair.
2. In each tenant's Admin settings, select the target store and save its destination Chat ID. Saving a valid Chat ID automatically binds/enables that store; clearing the Chat ID unbinds it. Event toggles remain store-specific. Add the Bot to the target Telegram group and grant it permission to send messages.
3. Configure and enable the global Client Bot in Super Admin settings if customer notifications are required.
4. Set `TELEGRAM_CLIENT_WEBHOOK_SECRET` and register the Client Bot webhook to the public endpoint described above.
5. Set `TELEGRAM_NOTIFICATION_WORKER_ENABLED=true` in the application environment, restart the application, and verify worker startup in logs.
6. Perform staging end-to-end tests for new order, settlement, KHQR confirmation, refund, customer binding/revocation, retry, worker restart, and cross-store isolation before enabling in production.

## Bot setup and operational troubleshooting

### Bot commands and ownership

- Create the Client Bot and Admin Bot separately with Telegram's official BotFather. Keep their tokens independent; never paste tokens into issue comments, screenshots, chat messages, or committed environment files.
- The Client Bot is the only Bot customers should open. Customers start it using the one-time deep link generated from their active FoodFlow customer session. The bot accepts private-chat `/start <one-time-challenge>` and `/stop` commands only; it does not accept arbitrary customer IDs or bearer tokens in Telegram commands.
- The Admin Bot is added to each store's target group. The super-admin configures only the shared Bot token; each store separately configures its own group Chat ID and event toggles. The super-admin does not configure a business-notification destination, and a store does not receive its own Bot token.
- Do not configure the shared Client Bot Chat ID as a customer destination. Customer order notifications must resolve from an active, owner-checked binding.
- Bot tokens are currently stored in the protected `settings` table as plaintext; the Super Admin API masks them, but there is no application-level encryption at rest. Backups include the `settings` table and therefore contain Bot tokens. Treat database backups as secrets: retain automatic files with restrictive permissions, encrypt off-host copies, and never attach backup files to tickets or chats. Application-level token encryption remains a security-hardening item.

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

- **Webhook returns 403:** verify the reverse proxy preserves `X-Telegram-Bot-Api-Secret-Token` and the configured secret matches byte-for-byte. Do not log the header.
- **Webhook cannot be reached:** verify public HTTPS, certificate validity, reverse-proxy routing to `POST /api/telegram/client/webhook`, and that the application route is mounted.
- **Customer binding does not complete:** confirm the customer still has an active scan session, the one-time challenge has not expired or been consumed, and the Client Bot is enabled. Generate a fresh link rather than reusing an old one.
- **Store group receives nothing:** verify the Admin Bot is enabled, is a member of that store's configured group, can send messages, the store Chat ID is correct, and the relevant event toggle is on.
- **Customer receives nothing:** verify the Client Bot is enabled and the customer has an active binding for the same merchant and store as the order. The shared Client Bot Chat ID is not a fallback.
- **Messages remain pending or retry:** verify outbound HTTPS connectivity to `api.telegram.org`, Bot token validity, and the worker's opt-in environment flag. The business transaction does not wait for Telegram delivery.
- **Dead-letter entries:** inspect the safe `last_error_code` and attempt count using an authorized operational database session. Do not expose Bot tokens, webhook secrets, raw Telegram payloads, or customer bearer values in support logs.
- **Worker restart:** expired processing leases become eligible for reclaim after their lease deadline. Delivery is at-least-once, so the crash window after Telegram acceptance but before database acknowledgement can produce a duplicate.

The worker's safe log messages identify a failed cleanup or batch without printing raw exception text. Operational alerting for sustained pending/dead-letter growth should be configured by the deployment operator; CI cannot verify production alert delivery.

### Safe operational diagnostics

Run `npm run telegram:diagnose` from the application root. The command reads the application's `.env`, checks the worker flag and webhook-secret length, reports whether the two Bot profiles are configured, counts active customer bindings and enabled store recipients, summarizes outbox states, and checks the Client Bot webhook with Telegram's `getWebhookInfo` API. It deliberately does not print Bot tokens, Chat IDs, webhook secrets, notification payloads, or raw database errors. If a notification table is missing, its section reports `available: false` rather than exposing database details.

Interpret zero active customer bindings as customers not yet linked through the customer-page Telegram button and `/start` flow. Interpret zero enabled store recipients as stores not yet configured with their own Chat ID and event toggles. A registered webhook does not create either kind of recipient.

## Remaining acceptance work

- Staging end-to-end delivery proof and restart/lease-recovery soak testing are still required. CI success does not replace Telegram delivery verification against real test Bots and Chat IDs.
- Verify the production deployment environment has the webhook secret and worker flag configured before any rollout.
- Review dead-letter operational monitoring/alerting with the deployment operator.
- PR #266 is merged. The end-to-end staging acceptance items above remain open and are tracked by [Issue #265](https://github.com/Tony855/shaolafang/issues/265). A successful webhook registration or green CI run alone is not evidence that customer and store notifications have been delivered.


## Multi-group subscription routing — staging-gated rollout

- `TELEGRAM_GROUP_SUBSCRIPTIONS_ROUTING_ENABLED` defaults to `false`. With the flag off, merchant notifications continue using the legacy `telegram_store_admin_recipients` single-store path. The customer private-chat binding path is unchanged.
- Set the flag to `true` only in an isolated staging environment after PR #480's group destination and store subscription data has been populated and reviewed. When enabled, each active destination/store subscription receives its own outbox row. The event key is suffixed with the destination ID and the recipient key is `destination:<destinationId>:store:<storeId>`; this preserves per-destination idempotency.
- In routing mode, old queued `store:<storeId>` jobs are terminally suppressed. They never fall back to the legacy table, preventing duplicate or stale sends. There is no fallback to the old recipient if a store has no active group subscriptions.
- Group subscription writes lock `store → destination → subscription → outbox`. Group enqueue locks both global Bot settings and the merchant before `store → destination → subscription → outbox`; the worker's irreversible-send boundary locks the admin Bot setting and active merchant before `store → destination → subscription → outbox`. Customer consent remains independently serialized as `binding → outbox`.
- Disabling a destination, disabling a store subscription, turning off an event toggle, or removing a subscription marks matching `pending/processing` jobs dead in the same transaction. Re-enabling does not resurrect them. A job already in `sending` has crossed the irreversible boundary and cannot be recalled; the worker rechecks the live destination, store, subscription and event toggle immediately before that transition.
- Staging acceptance must cover multiple groups per store, multiple stores per group, independent event flags, cross-merchant rejection, no legacy fallback, Bot-disabled behavior, unsubscribe/disable races, customer binding revoke races, and outbox idempotency on MySQL and MariaDB.
- Keep `TELEGRAM_GROUP_SUBSCRIPTIONS_ROUTING_ENABLED=false` in production until staging acceptance is explicitly signed off. Keep the delivery worker disabled in production until the separate worker approval/rollout step; this feature flag does not enable the worker.
