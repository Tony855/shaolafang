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
- Disabling a profile stops delivery for that profile without deleting its saved token or Chat ID. Already queued notices for a globally disabled Bot are terminally suppressed as `event_disabled`; re-enabling the Bot does not release that backlog.
- Business notifications are delivered from a durable database outbox. Telegram network calls happen after the order/payment/refund transaction commits; retryable failures do not roll back business transactions.
- The worker is disabled by default. Set `TELEGRAM_NOTIFICATION_WORKER_ENABLED=true` only after staging end-to-end acceptance and explicit operator approval. Leave it unset or `false` during installation, testing, maintenance, and rollback. The worker uses one in-flight send at a time and stops before the database pool during graceful shutdown.
- The Admin Bot token is global and is used only as the shared transport credential. The super-admin does not configure a business Chat ID or receive store business notifications; each store's separately configured Chat ID is the exclusive destination for that store's business messages.
- Current business-notification delivery is store-scoped only: the Admin Bot transports messages to the matching store Chat ID, with event toggles controlling new-order, settlement, and refund notifications. Legacy queued super-admin business messages are suppressed. The Client Bot's configured Chat ID is used only for its fixed test message; private customer notices are routed only to a customer's own Telegram chat after the binding flow below.

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

1. Configure and enable the Client Bot in **Global settings → Telegram Bot**. On save, FoodFlow calls Telegram `setChatMenuButton` and sets the default private-chat menu button to **🍽️ 外卖点餐**, pointing to `https://<FOODFLOW_PUBLIC_URL-host>/telegram-delivery.html`.
2. Set `FOODFLOW_PUBLIC_URL` to the public HTTPS origin and register the Client Bot webhook as described above.
3. In @BotFather, configure the Web App domain using `/setdomain` with the same FoodFlow hostname.
4. A customer opens the Client Bot chat and taps the built-in **🍽️ 外卖点餐** menu button. Telegram opens the FoodFlow Mini App directly.
5. If one active store exists, the Mini App opens that store's delivery page automatically. If multiple active stores exist, the customer selects a store first. The selection page only returns public active store IDs and names.
6. The selected store's existing `delivery-order.html` storefront runs inside Telegram. Menu, cart, checkout, cash/KHQR payment, and delivery tracking continue to use the existing FoodFlow APIs and order records. Customers can still bind their Telegram private chat from the delivery page to receive private order notifications.

The menu button is configured globally for the Client Bot when the super-admin saves its Telegram configuration. If Telegram rejects the menu-button update, the configuration API returns `menu_button_configured: false` and a safe `menu_button_error`; correct the HTTPS URL, Bot token, or BotFather domain and save again. Disabling the Client Bot resets the menu button to Telegram's default commands button.

The Mini App store selector is not an authentication mechanism. It does not trust Telegram `initData` as an order credential. Order authorization continues to use the existing high-entropy customer bearer token, and the backend revalidates store status, menu items, availability, and totals. No customer identity or order permission is granted by the menu button itself.

