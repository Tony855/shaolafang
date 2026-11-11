# Payment event inbox and financial journal foundation

## Scope of this change

This change adds database foundations and provider-neutral validation helpers. It does **not** create a public payment callback endpoint, claim to verify any bank signature, settle orders automatically, or post journal entries from existing cash/KHQR flows.

The existing KHQR workflow remains staff-mediated: a waiter can notify the cashier, and a cashier confirms receipt after checking the payment in the provider app. A QR payload, a QR CRC, a waiter notification, or a client-supplied transaction reference is not proof of bank settlement.

## Provider event inbox

`provider_webhook_events` stores provider/event identity, merchant/store scope, event type, provider transaction reference, a SHA-256 digest of the raw request body, authentication status, processing status, and timestamps. It deliberately does not persist raw callback bodies, authorization headers, signatures, API keys, or other credentials.

The unique key on `(provider_code, provider_event_id)` is the durable duplicate-delivery guard. Event intake must be implemented only after the exact provider is selected and its official callback contract is available. Before an event may move to `verified`, its adapter must validate the provider's documented signature/authentication mechanism against the exact raw bytes and validate merchant/account ownership, amount, currency, order reference, and final payment state. Only then may an idempotent transaction lock the target order, record the provider transaction, and transition a permitted order state.

Do not guess HMAC algorithms, signature headers, key encodings, timestamp tolerances, or status mappings. ABA PayWay, Bakong/NBC, and other providers may have different contracts. Reject unknown/invalid events; do not let browser or staff-facing routes impersonate a provider callback.

## Financial journal

- `financial_journal_transactions` is the idempotent journal header, scoped to merchant and store.
- `financial_journal_entries` contains immutable debit/credit lines in integer minor units, with a foreign key that prevents deleting a journal header while entries exist.
- A journal transaction must balance exactly within one currency. Cross-currency conversion requires explicit clearing/FX entries and must not compare unlike minor units directly.
- Unique tenant-scoped idempotency keys prevent duplicate posting when the eventual writer uses a transaction and handles duplicate-key replay.
- Corrections should be posted as reversing/adjusting transactions; do not update or delete posted lines in ordinary application workflows.

The helper in `server/services/financial-ledger.js` validates provider event envelopes and balanced journal drafts. It is not a database writer and intentionally does not mark webhook events as authenticated.

## Migration, backup, and compatibility

The tables are created idempotently during database initialization. Full backups now include the event inbox and both journal tables. Restore imports headers before journal entries and deletes in reverse dependency order. Older backups that lack these three tables are accepted and restore them as empty.

No historical orders, refunds, cash receipts, or KHQR confirmations are automatically backfilled. Existing `orders.total`, `orders.refund_amount`, and `refund_requests` remain authoritative for current application behavior until a separately reviewed reconciliation/backfill migration is prepared.

## Required next integration gate

Before enabling any provider webhook or financial posting in production:

1. Identify the exact provider product/account and obtain its official current callback specification and test credentials.
2. Implement a provider-specific raw-body verifier and contract tests (valid, invalid, stale, wrong merchant, wrong amount/currency, duplicate, delayed, out-of-order, and replayed events).
3. Add a transactional inbox worker with leases/retries, terminal-state rules, and unique provider transaction references.
4. Add an order-to-journal posting policy for payment, refund, fee, settlement, chargeback, and reversal events.
5. Reconcile provider settlement reports against journal totals and existing order/refund records; document any opening-balance backfill.
6. Run migration, backup/restore, concurrency, and load tests against a staging database before production rollout.
