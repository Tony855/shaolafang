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
- Disabling a profile stops the test endpoint from sending messages. It does not delete the saved token or Chat ID.
- These settings establish the two Bot identities and validate outbound delivery. Business-event routing (for example, order-created, payment-confirmed, or customer order-status notifications) must be connected to the relevant event handlers separately; this change does not silently send business data to Telegram.

Keep Bot tokens private. If a token is exposed, revoke it with @BotFather and replace it in the super-admin console.
