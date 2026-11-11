# Transactional payment intake and journal posting

This phase adds database-backed service methods on top of the provider-neutral schema. It does not expose an HTTP callback route or activate a provider integration.

## Verified provider event intake

`createFinancialLedgerService().recordVerifiedProviderEvent()` requires a provider adapter verification result that explicitly matches the normalized provider code. The service then inserts the event under a database transaction and locks the unique provider/event row. Re-delivery with the same tenant scope and SHA-256 body digest is idempotent. Reuse of the provider event ID with a different digest or merchant/store scope is rejected as an identity collision.

The adapter remains responsible for authenticating the exact raw request bytes using the provider's official current contract and validating account ownership, order reference, amount, currency, and final status. The boolean verification result is an internal service boundary, not a substitute for implementing that adapter. Do not accept it from a request body, query string, browser, or staff UI.

Raw webhook payloads, authorization headers, signatures, and secrets are not persisted.

## Journal posting

`postJournalTransaction()` validates the draft, inserts the journal header under a merchant/store-scoped idempotency key, locks the header, and compares any existing lines before deciding whether this is an exact replay. New lines are inserted in the same transaction. A reused key with changed header identity or changed accounting lines is rejected; it never silently returns an unrelated posting.

The caller must supply a balanced accounting policy for the event type. This service does not infer whether a payment is revenue, tax, tip, receivable, clearing, fee, refund, chargeback, or settlement. Those mappings require an approved chart of accounts and accounting policy.

## Operational constraints

- Always call these methods inside the supplied `withTransaction` implementation; the factory wires the existing transaction-aware DB helpers.
- A provider event is recorded as verified only after the provider-specific adapter succeeds.
- Do not invoke order state transitions from the inbox write itself. A separate worker must claim verified events, validate order state under row lock, apply a provider-specific event transition, and post the corresponding balanced journal transaction atomically.
- Journal rows are append-only by application policy. Corrections use a new reversal/adjustment transaction.
- No live provider credentials, webhook route, order auto-settlement, or historical backfill is included in this phase.
