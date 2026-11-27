# Telegram Bot configuration

FoodFlow uses exactly two platform-wide Telegram Bots, both configured only by the super administrator:

- **Client Bot**: one shared customer-facing Bot for every tenant. It handles customer binding, Mini App entry, ordering and customer notifications.
- **Admin Bot**: one shared store-notification Bot for every tenant. It sends order, settlement and refund notices to the corresponding tenant/store group.

Tenants never create Bots or enter Bot Tokens. Each tenant only binds its own store/group Chat IDs and notification preferences in its authenticated Admin settings. The Client Bot's optional Chat ID in the super-admin form is only a fixed test-message destination; it is not used for customer order details.

## Configure

1. Open the super-admin console and go to **Global settings → Telegram Bot**.
2. Create the required bot(s) with Telegram's **@BotFather** and copy each bot token.
3. Add the Admin Bot to each tenant's target store group and grant permission to send messages. Add the Client Bot only where customers will use it.
4. Configure the two Bot Tokens in the matching Client Bot and Admin Bot sections of the super-admin page. The Client Bot Chat ID is only for its test message; the Admin Bot does not have a global business Chat ID.
5. Enable the profiles and save. Use **Send test message** to verify each Bot. In each tenant's Admin settings, bind the Chat ID for each store and choose its order/settlement/refund event toggles.

A blank token field preserves the previously saved token. Use the explicit **Clear saved token** option to remove it. The configuration API never returns the token in plaintext; the UI displays only a masked suffix.

## Discover a group Chat ID from Admin settings

1. Add the shared platform Admin Bot to the target Telegram group and allow it to send messages.
2. In the group, send `/start@YourAdminBotUsername` (replace the username with the actual Bot username). If the group has privacy mode enabled, a command addressed to the Bot is the reliable way to make the update visible.
3. Open FoodFlow Admin → Settings → Telegram store notifications and click **获取群组 ID**.
4. Select the discovered group. FoodFlow fills its numeric Chat ID into the field; click **保存 Telegram 通知设置** to bind it to the current store.

The endpoint returns only group/supergroup IDs, titles, types, and optional public usernames. It does not return message text or sender information. It is protected by the existing admin authentication and `can_manage_store` permission, and validates the active merchant/store context.

**Important:** Telegram `getUpdates` cannot run while a webhook is configured for the same Bot. The platform Admin Bot is intended for outbound notifications and this on-demand discovery flow; do not attach a webhook or run another polling consumer for it. The discovery call acknowledges the updates it has read to prevent Telegram's pending-update queue from growing. If the Admin Bot is webhook-managed by another integration, use that integration's update receiver to obtain the Chat ID instead. The Client Bot webhook is separate and is not affected.

## Security and behavior

- Only authenticated super-admin endpoints can read or change these settings.
- Tokens are stored in the application's settings database and are never included in API responses, audit text, or application error messages.
- Test delivery sends a fixed FoodFlow verification message to the configured Chat ID. It does not accept arbitrary text or a caller-supplied Telegram API URL.
- Disabling a profile stops outbound delivery without deleting its saved token or Chat ID. Already queued notices for a globally disabled Bot are terminally suppressed as `event_disabled`; re-enabling the Bot does not release that backlog. The shared Client Bot webhook remains registered while outbound notices are disabled so customers can still send `/stop` to revoke consent. Clearing or rotating the Client Bot Token removes the old Bot webhook.
- Business notifications are delivered from a durable database outbox. Telegram network calls happen after the order/payment/refund transaction commits; retryable failures do not roll back business transactions.
- The worker is disabled by default. Set `TELEGRAM_NOTIFICATION_WORKER_ENABLED=true` only after staging end-to-end acceptance and explicit operator approval. Leave it unset or `false` during installation, testing, maintenance, and rollback. The worker uses one in-flight send at a time and stops before the database pool during graceful shutdown.
- The Admin Bot token is global and is used only as the shared transport credential. The super-admin does not configure a business Chat ID or receive store business notifications; each store's separately configured Chat ID is the exclusive destination for that store's business messages.
- Current business-notification delivery is store-scoped only: the Admin Bot transports messages to the matching store Chat ID, with event toggles controlling new-order, settlement, and refund notifications. Legacy queued super-admin business messages are suppressed. The Client Bot's configured Chat ID is used only for its fixed test message; private customer notices are routed only to a customer's own Telegram chat after the binding flow below.

Keep Bot tokens private. If a token is exposed, revoke it with @BotFather and replace it in the super-admin console.


## Private customer binding (feature branch)

Customer notifications never use the Client Bot's shared configured Chat ID. Each customer must bind their current FoodFlow customer token to a private Telegram chat:

1. Generate a strong webhook secret (at least 32 characters), for example:
   ```sh
   openssl rand -hex 32
   ```
2. Set `TELEGRAM_CLIENT_WEBHOOK_SECRET` and `FOODFLOW_PUBLIC_URL` (public HTTPS origin) in the FoodFlow environment.
3. Configure and enable the shared Client Bot Token in **Global settings → Telegram Bot**. Saving the configuration and application startup synchronize the Client Bot menu button and call Telegram `setWebhook` automatically. No tenant-specific Bot Token or webhook URL is required.
4. If the webhook secret or HTTPS origin is missing/invalid, the super-admin page reports the synchronization error; correct the environment and resave/restart.
5. The worker remains stopped by default. After staging end-to-end verification and explicit approval, set `TELEGRAM_NOTIFICATION_WORKER_ENABLED=true` on the intended environment and restart the application. To pause delivery, unset the variable or set it to `false`.
6. A customer scans a table QR code, taps the Telegram icon in the customer page header, and opens the generated private deep link. They must press **Start** in Telegram. Returning to FoodFlow refreshes the binding state. Customers can revoke immediately from the Telegram chat at any time by sending `/stop`; this revokes all active FoodFlow customer-notification bindings belonging to that exact Telegram private user/chat.

Binding details:
- A one-time random challenge is stored only as a SHA-256 hash and expires after 10 minutes.
- The webhook accepts only authenticated private-chat `/start` and `/stop` updates. Telegram `update_id` values are persisted to reject replayed updates.
- A Telegram chat can be bound to one customer token per store. Customer tokens rotate with QR scans; completing a fresh one-time challenge from the current customer session can move the same private chat to the new session identity for that store. Old binding rows are removed and queued notices for the previous identity are terminally suppressed. The same private chat may be used independently for another store.
- In-page revocation is authenticated with the current customer token and scan-session headers. The private-chat `/stop` command also supports revocation after the QR session expires; it only disables bindings matching both the Telegram user ID and private chat ID. Both paths terminally suppress already queued customer notices; reactivating an old binding also suppresses any pre-opt-out jobs, even if the customer later binds again.
- Customer notification recipients are resolved by binding ID plus exact merchant/store IDs. Inactive, revoked, missing, or cross-store bindings fail closed.
- The existing shared Client Bot Chat ID is never used for per-customer order details.

## Customer delivery Mini App menu button

The customer Client Bot exposes FoodFlow ordering directly from Telegram's chat menu button. Customers do not need to visit the FoodFlow website first, tap a website launch button, or send a `/start delivery_<store_id>` command.

1. Configure and enable the Client Bot in **Global settings → Telegram Bot**. On save, FoodFlow calls Telegram `setChatMenuButton` and sets the default private-chat menu button to **🍽️ 外卖点餐**, pointing to `https://<FOODFLOW_PUBLIC_URL-host>/telegram/delivery`.
2. Set `FOODFLOW_PUBLIC_URL` to the public HTTPS origin and register the Client Bot webhook as described above.
3. In @BotFather, configure the Web App domain using `/setdomain` with the same FoodFlow hostname.
4. A tenant admin saves the current store's Telegram group Chat ID in **Store settings → Telegram store notifications**. FoodFlow returns a dedicated Client Bot deep link for that store.
5. Share that link or its QR code with the store's customers. Opening it starts the shared Client Bot with a signed `delivery_<store_id>_<signature>` payload; the webhook resolves the store only through the currently active `merchant_id + store_id` Chat ID recipient binding.
6. Telegram then opens the existing delivery storefront for that store directly. No public cross-tenant store list or manual store selector is shown. The HMAC signature is bound to the store ID and current Chat ID using `TELEGRAM_CLIENT_WEBHOOK_SECRET`; changing or clearing the Chat ID invalidates previously issued links. The checkout API rechecks the binding before accepting Telegram-originated orders.
7. Customer Telegram identity binding and customer order bearer tokens remain separate from the store entry signature. The entry signature determines the store only; it does not authenticate a customer or grant access to an order.

The menu button is synchronized globally for the Client Bot both during server startup (so existing enabled Bot configurations are picked up after deployment) and when the super-admin saves Telegram settings. If Telegram rejects the menu-button update, the configuration API returns `menu_button_configured: false` and a safe `menu_button_error`; correct the HTTPS URL, Bot token, or BotFather domain and save again. Disabling the Client Bot resets the menu button to Telegram's default commands button.

The Mini App store selector is not an authentication mechanism. It does not trust Telegram `initData` as an order credential. Order authorization continues to use the existing high-entropy customer bearer token, and the backend revalidates store status, menu items, availability, and totals. No customer identity or order permission is granted by the menu button itself.

## Delivery and limitations

- Current event hooks include order creation, admin/cashier settlement, actual KHQR/manual payment confirmation, and successful refunds. A waiter request to confirm KHQR is not treated as a successful payment.
- Admin Bot credentials remain global rather than merchant-owned. Store-specific Chat IDs and per-event toggles are implemented; they share the global Admin Bot token while preserving exact merchant/store recipient isolation.
- The outbox records `sending` before the external API call. Expired `sending` leases and ambiguous Telegram responses move to `uncertain` and are not automatically replayed. Confirmed deliveries retain Telegram's message ID. For customer notices, the worker locks and rechecks the exact active binding in the same transaction that changes `processing` to `sending`, using the same binding → outbox lock order as `/stop` and page revocation. If revocation wins that lock, the task is suppressed before Telegram is called; once the task crosses into `sending`, it is treated as in-flight and an already-started Telegram request cannot be recalled.
- Failed tasks retry with bounded exponential backoff and eventually enter the dead-letter state. Telegram HTTP 429 responses honor `parameters.retry_after`, capped at one hour. Monitor `telegram_notification_outbox` for `state='dead'`.
- Webhook update IDs are retained for 30 days; expired and consumed binding challenges are cleaned during new challenge creation. Before restoring a database backup, disable the Telegram worker on every application node and wait for in-flight sends to finish. After restore, customer Telegram bindings/challenges are invalidated because old customer bearer sessions are not restored; customers must scan again and rebind. Pending customer notifications from the restored snapshot are dead-lettered instead of retrying against stale bindings.
## Staging acceptance checklist

Run this only against a disposable staging database and dedicated test Bot accounts/Chat IDs. Keep the worker disabled on production.

1. Configure independent Client/Admin Bot tokens in the super-admin console. Verify each fixed test message reaches only its configured test chat.
2. Set `TELEGRAM_CLIENT_WEBHOOK_SECRET` and register the Client Bot webhook. Confirm `getWebhookInfo` reports the expected HTTPS webhook URL and no persistent delivery error.
3. Create two merchants with at least two stores. Configure a distinct Chat ID for every store from its tenant Admin session. Saving the Chat ID automatically binds that store; clearing it removes the binding. Set event toggles independently per store.
4. Create a customer order in each store. Verify the global admin chat receives the global event and each store chat receives only its own store event; identical numeric store IDs under different merchant contexts must never cross-resolve.
5. Bind a customer private chat, create an order, then rescan to rotate the customer token and complete a new deep-link challenge. Verify the same private chat follows the new session identity, while another store's binding remains untouched.
6. Trigger settlement, KHQR/manual payment confirmation, and a completed refund. Verify only the intended events arrive and no QR payload, customer bearer token, phone number, or private note appears.
7. Test both in-page revoke and `/stop`. Confirm queued customer jobs move to `dead` with `binding_revoked`; rebind and verify those old jobs are not sent.
8. Stop the worker before a job is claimed and verify safe lease recovery. Separately interrupt a job after it enters `sending`; verify it moves to `uncertain` after lease expiry and is not automatically resent. Confirm operators can inspect the row before deciding whether to replay it.
9. With every worker stopped on every app node, restore a staging backup. Verify customer bindings/challenges are cleared, pending customer jobs are dead-lettered, store/admin configuration is restored, and customers can bind again.
10. Inspect logs and the outbox summary for redaction. Do not paste Bot tokens or webhook secrets into tickets or chat.

A useful queue health query (it does not expose message payloads or credentials):

```sql
SELECT state, recipient_scope, last_error_code, COUNT(*) AS total
FROM telegram_notification_outbox
GROUP BY state, recipient_scope, last_error_code
ORDER BY state, recipient_scope, last_error_code;
```

- The full client/merchant notification workflow still requires staging end-to-end tests before production enablement.


## Notification delivery safety

Outgoing business notifications use a database outbox with a unique event key. A task moves through `pending`, `processing`, and `sending` before Telegram is called. The `sending` state is persisted before the external request so an expired send lease is never automatically replayed.

If the Telegram response is ambiguous (network timeout, unreadable response, or HTTP 5xx), the task is moved to `uncertain` and requires operator review. This intentionally favors avoiding duplicate customer messages over silently retrying a send that Telegram may already have accepted. Confirmed successful responses are stored as `delivered` together with Telegram's message ID. Explicit Telegram rejections such as invalid chat permissions and flood control continue through the normal safe retry/dead-letter path.

Telegram does not provide a general idempotency key for `sendMessage`; therefore absolute exactly-once delivery cannot be guaranteed. Operators should inspect `uncertain` rows before any manual replay.

## Customer Mini App entry points

- The shared Client Bot exposes a platform-wide fallback menu button that only explains how to obtain a store-specific link; it never lists or selects stores.
- A customer with no active store binding must first open the signed store-specific deep link supplied by the store administrator. After the webhook verifies the current store Chat ID binding, it sets a chat-scoped private menu button for that Telegram customer chat, pointing to the same signed store URL. The accompanying inline button opens the same URL immediately. Later plain `/start` commands resume the most recently updated active store binding without requiring the customer to repeat the deep link.
- A plain `/start` or `/help` first resumes the customer's most recently updated active Telegram binding whose tenant, store, and Chat ID recipient are still enabled; FoodFlow regenerates the current Chat ID-bound signature and opens that store directly. If no eligible binding exists, it asks the customer to use a store administrator's dedicated link once. It never exposes a public Mini App selector or an unbound ordering button.
- If the store Chat ID changes or is cleared, the signed URL retained in the customer's menu button becomes invalid. The customer must obtain and open the latest dedicated link to refresh the private menu button.
- The Bot API menu button and webhook require `FOODFLOW_PUBLIC_URL` to be a public HTTPS origin and `TELEGRAM_CLIENT_WEBHOOK_SECRET` to be 32–256 characters from `[A-Za-z0-9_-]`.
- Telegram's separate profile-page **Open App** button is the Main Mini App feature and must be configured once for the shared Client Bot in `@BotFather → Bot Settings → Configure Mini App`. The Bot API `setChatMenuButton` does not configure this profile button.


## Multi-group notification routing (staging only)

The merchant group subscription manager is separate from the customer private-chat binding. To exercise the new group routing in staging, set `TELEGRAM_GROUP_SUBSCRIPTIONS_ROUTING_ENABLED=true` only after reviewing the destination/store subscriptions. Leave it `false` in production until staging acceptance is complete. This setting does not start the notification worker; `TELEGRAM_NOTIFICATION_WORKER_ENABLED` remains a separate control.
