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

The API does not yet register Telegram webhooks or switch customer traffic. That is intentionally deferred to the next stage. Existing shared Bot settings and routes remain active during this foundation phase.

## Data model

- `telegram_merchant_bots`: one row per merchant; stores encrypted Client/Admin Bot tokens, fingerprints, Bot usernames, enabled flags, and encrypted per-tenant webhook path/secret material.
- `telegram_merchant_webhook_updates`: update replay protection scoped by `(bot_config_id, update_id)`.
- The existing shared Bot settings and `telegram_webhook_updates` table are retained for compatibility.

Both new tables are included in backup/restore. The encrypted credentials are only useful when restored together with the matching encryption key.
