# Tenant Telegram Bot configuration foundation

FoodFlow currently treats `merchants.id` as the tenant boundary. This foundation adds one Telegram Bot configuration row per merchant; a merchant may continue to own multiple stores.

## Encryption key

Before a tenant administrator saves a Bot token, configure:

```sh
TELEGRAM_BOT_ENCRYPTION_KEY='<64-character-hex-encoded-32-byte-key>'
```

Generate a key with:

```sh
openssl rand -hex 32
```

Keep the key in the server secret store or root-owned environment file. Do not commit it, return it from an API, or write it to logs. The key must remain stable across restarts and must be included in the operator's protected disaster-recovery procedure. Losing the key makes encrypted tenant Bot credentials unrecoverable. Do not rotate it until a key-rotation migration is implemented.

The schema migration can run without this key because it does not write credentials. Credential creation fails closed when the key is missing or malformed.

## Merchant administrator API

Only a tenant primary administrator can manage credentials:

- `GET /api/admin/telegram/bot` returns enabled flags, configured flags and Bot usernames. It never returns tokens, encrypted values, webhook path tokens or webhook secrets.
- `PUT /api/admin/telegram/bot` accepts optional `clientBotToken`, `adminBotToken`, `clientBotEnabled` and `adminBotEnabled`.
- To clear a saved credential, send `clearClientBotToken: true` or `clearAdminBotToken: true`. Clearing a token also disables that Bot profile.
- Supplied tokens are checked with Telegram `getMe` before they are stored.
- A Bot token fingerprint is unique across tenants for the same profile, preventing accidental reuse of one Bot across multiple tenant entries.

The API registers the tenant Client Bot webhook when it is enabled, and disables the webhook when the Client Bot is disabled or cleared. The webhook URL contains the high-entropy tenant path token; only its SHA-256 digest is stored. Each tenant update is authenticated with that Bot's own webhook secret and deduplicated by `(bot_config_id, update_id)`. The existing shared Bot route remains available only for merchants that have not enabled a tenant Client Bot.

## Data model

- `telegram_merchant_bots`: one row per merchant; stores encrypted Client/Admin Bot tokens, fingerprints, Bot usernames, enabled flags, and encrypted per-tenant webhook path/secret material.
- `telegram_merchant_bot_token_registry`: globally unique Bot token fingerprints across all tenant profiles, preventing the same Bot identity from being assigned to multiple tenants or to both roles.
- `telegram_merchant_webhook_updates`: update replay protection scoped by `(bot_config_id, update_id)`.

## Tenant customer entry

- A tenant's Bot deep links are signed with a tenant-scoped HMAC over `(merchant_id, store_id)`; the signature no longer depends on the merchant notification group Chat ID.
- The Mini App menu carries the tenant's opaque Bot path token and lists only that merchant's active stores.
- Customer and merchant-group notifications resolve the tenant's own Client/Admin Bot credentials. A configured tenant Bot profile is authoritative; the platform shared Bot is used only for merchants without a tenant Bot configuration.
- Group discovery uses the tenant Admin Bot. Its token is not reused by another merchant.
- Store checkout verifies Telegram `initData` with the tenant Client Bot token, checks that the store belongs to that merchant, and verifies the tenant/store signature again on the server.
- `/start`, `/stop`, recent-store lookup, customer binding challenges, and webhook update deduplication are scoped to the tenant resolved from the webhook path.
- Legacy shared-Bot flows remain for unmigrated merchants and are prevented from resolving or revoking bindings belonging to merchants with an enabled tenant Client Bot.
- The existing shared Bot settings and `telegram_webhook_updates` table are retained for compatibility.

All three new tables are included in backup/restore. The encrypted credentials are only useful when restored together with the matching encryption key.
