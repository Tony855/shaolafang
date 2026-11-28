# Telegram private destinations for merchant notifications

The shared platform Admin Bot can be registered as a merchant notification destination in a private chat, group, or supergroup. Private merchant destinations are separate from the Client Bot customer-binding flow.

## Private chat setup

1. Open the shared Admin Bot in Telegram and send /start (or /start@BotUsername).
2. In FoodFlow Admin, open Settings → Telegram destinations.
3. Use the discovery control. The group discovery endpoint returns only group/supergroup IDs, titles, types, and optional usernames; it does not return message text or sender details. Private Chat IDs must be entered manually.
4. Select the private destination, register it, and subscribe only the stores the authenticated admin is authorized to manage.
5. Set independent order-created, settlement, and refund toggles for each store/destination subscription.

Private Chat IDs are positive numeric IDs. Group and supergroup Chat IDs are negative numeric IDs. Private Chat IDs are registered manually and are not returned by the shared Admin Bot discovery endpoint, because global private-chat discovery could expose other merchants' admin IDs. Group discovery remains available but is not tenant-scoped yet (tracked separately). A webhook or another getUpdates consumer on the Admin Bot prevents group discovery from working.

## Isolation and delivery

- Private merchant destinations use the shared Admin Bot; customer private-chat binding and /stop revocation remain on the Client Bot and are not reused.
- Destination IDs remain merchant-owned. A store subscription is accepted only after the current merchant/store authorization is checked.
- Chat IDs remain globally unique in the destination table, so one destination cannot be claimed by multiple merchants.
- Each store/destination pair has independent event toggles and idempotent outbox keys.
- Group/private destination routing remains staging-gated by TELEGRAM_GROUP_SUBSCRIPTIONS_ROUTING_ENABLED. This feature code does not enable the flag in production.

## Migration

The startup schema helper widens an existing destination Chat-Type ENUM to include private without rebuilding the table. Legacy positive numeric Chat IDs are classified as private during the idempotent subscription backfill; invalid IDs and cross-merchant ownership conflicts remain quarantined for manual resolution. This code change does not execute a production migration in this audit.

## Staging acceptance

Before enabling routing, use disposable staging data and dedicated test Bots to verify manual private Chat-ID registration, group discovery, authorized store subscriptions, event toggles, duplicate suppression, cross-merchant rejection, disable/revoke races, outbox retries/dead-letter, worker restart, and backup/restore. Do not use production credentials, real customer data, or real funds.
