# Telegram Bot configuration

FoodFlow supports two independent outgoing Telegram Bot profiles in the super-admin console:

- **Client Bot**: a bot identity reserved for client/customer-facing Telegram integration.
- **Admin Bot**: a separate bot identity and recipient for administrator-side Telegram messages.

Each profile has its own enabled flag, BotFather token, and recipient Chat ID. The profiles do not share credentials or recipients.

## Configure

1. Open the super-admin console and go to **Global settings → Telegram Bot**.
2. Create the required bot(s) with Telegram's **@BotFather** and copy each bot token.
3. Start a conversation with the bot, or add it to the target group/channel with permission to send messages.
4. Obtain the destination Chat ID (numeric user/group ID, or a public channel username such as `@foodflow_updates`).
5. Enter the token and Chat ID for the appropriate profile, enable it, and save.
6. Use **Send test message** for each profile to verify Telegram API connectivity and recipient permissions.

A blank token field preserves the previously saved token. Use the explicit **Clear saved token** option to remove it. The configuration API never returns the token in plaintext; the UI displays only a masked suffix.

## Security and behavior

- Only authenticated super-admin endpoints can read or change these settings.
- Tokens are stored in the application's settings database and are never included in API responses, audit text, or application error messages.
- Test delivery sends a fixed FoodFlow verification message to the configured Chat ID. It does not accept arbitrary text or a caller-supplied Telegram API URL.
- Disabling a profile stops delivery for that profile without deleting its saved token or Chat ID.
- Business notifications are delivered from a durable database outbox. Telegram network calls happen after the order/payment/refund transaction commits; retryable failures do not roll back business transactions.
- The worker is disabled by default. Set `TELEGRAM_NOTIFICATION_WORKER_ENABLED=true` only after webhook setup and staging verification. The worker uses one in-flight send at a time and stops before the database pool during graceful shutdown.
- The Admin Bot token is global. Its configured Chat ID is the global super-admin recipient; store-admin notifications use the same Bot token but route to each store's separately configured Chat ID. A store recipient is scoped to its exact active merchant/store and does not receive another store's events.
- For supported business events, the feature branch can queue both a global super-admin notification and a separately scoped store-admin notification. Store-level event toggles control new-order, settlement, and refund notifications. The Client Bot's configured Chat ID is used only for its fixed test message; private customer notices are routed only to a customer's own Telegram chat after the binding flow below.

Keep Bot tokens private. If a token is exposed, revoke it with @BotFather and replace it in the super-admin console.


## Private customer binding (feature branch)

Customer notifications never use the Client Bot's shared configured Chat ID. Each customer must bind their current FoodFlow customer token to a private Telegram chat:

1. Enable the Client Bot and save its BotFather token in **Global settings → Telegram Bot**. The Chat ID field is retained for the fixed test-message feature only.
2. Generate a strong webhook secret (at least 32 characters), for example:
   ```sh
   openssl rand -hex 32
   ```
3. Set `TELEGRAM_CLIENT_WEBHOOK_SECRET` in the FoodFlow environment to that secret and restart the application.
4. Register the webhook with Telegram. Set `FOODFLOW_PUBLIC_URL` to the public HTTPS origin and `CLIENT_BOT_TOKEN` to the Client Bot token in a protected shell environment:
   ```sh
   curl --fail --silent --show-error -X POST \
     "https://api.telegram.org/bot${CLIENT_BOT_TOKEN}/setWebhook" \
     --data-urlencode "url=${FOODFLOW_PUBLIC_URL}/api/telegram/client/webhook" \
     --data-urlencode "secret_token=${TELEGRAM_CLIENT_WEBHOOK_SECRET}"
   ```
5. Set `TELEGRAM_NOTIFICATION_WORKER_ENABLED=true` after staging verification. It defaults to `false`.
6. A customer scans a table QR code, taps the Telegram icon in the customer page header, and opens the generated private deep link. They must press **Start** in Telegram. Returning to FoodFlow refreshes the binding state. Customers can revoke immediately from the Telegram chat at any time by sending `/stop`; this revokes all active FoodFlow customer-notification bindings belonging to that exact Telegram private user/chat.

Binding details:
- A one-time random challenge is stored only as a SHA-256 hash and expires after 10 minutes.
- The webhook accepts only authenticated private-chat `/start` updates. Telegram `update_id` values are persisted to reject replayed updates.
- A Telegram chat can be bound to one customer token per store. Customer tokens rotate with QR scans; completing a fresh one-time challenge from the current customer session can move the same private chat to the new session identity for that store. Old binding rows are removed and queued notices for the previous identity are terminally suppressed. The same private chat may be used independently for another store.
- In-page revocation is authenticated with the current customer token and scan-session headers. The private-chat `/stop` command also supports revocation after the QR session expires; it only disables bindings matching both the Telegram user ID and private chat ID. Both paths terminally suppress already queued customer notices, even if the customer later binds again.
- Customer notification recipients are resolved by binding ID plus exact merchant/store IDs. Inactive, revoked, missing, or cross-store bindings fail closed.
- The existing shared Client Bot Chat ID is never used for per-customer order details.

## Delivery and limitations

- Current event hooks include order creation, admin/cashier settlement, actual KHQR/manual payment confirmation, and successful refunds. A waiter request to confirm KHQR is not treated as a successful payment.
- Admin Bot credentials remain global rather than merchant-owned. Store-specific Chat IDs and per-event toggles are implemented; they share the global Admin Bot token while preserving exact merchant/store recipient isolation.
- Delivery is at-least-once. A crash after Telegram accepts a message but before the database acknowledgement may result in a duplicate after lease recovery.
- Failed tasks retry with bounded exponential backoff and eventually enter the dead-letter state. Telegram HTTP 429 responses honor `parameters.retry_after`, capped at one hour. Monitor `telegram_notification_outbox` for `state='dead'`.
- Webhook update IDs are retained for 30 days; expired and consumed binding challenges are cleaned during new challenge creation. Before restoring a database backup, disable the Telegram worker on every application node and wait for in-flight sends to finish. After restore, customer Telegram bindings/challenges are invalidated because old customer bearer sessions are not restored; customers must scan again and rebind. Pending customer notifications from the restored snapshot are dead-lettered instead of retrying against stale bindings.
- The full client/merchant notification workflow still requires staging end-to-end tests before production enablement.
