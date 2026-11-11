# Financial reconciliation import foundation

## Scope

This stage adds a provider-neutral persistence layer for importing normalized bank/provider settlement statements. It does not parse proprietary ABA PayWay or Bakong files, call provider APIs, authenticate webhook signatures, match payments automatically, mutate orders, or post accounting entries.

## Import contract

An adapter must parse the provider's official statement format and supply:
- merchant and store scope derived from trusted server-side configuration;
- provider code and stable external batch identifier;
- SHA-256 digest of the exact original statement bytes;
- one ISO currency code per batch;
- normalized statement rows containing external reference, optional internal transaction reference, debit/credit direction, positive integer minor-unit amount, timestamp, and bounded description.

Unknown fields are rejected. Raw statement payloads, credentials, signatures, and bank account details are not stored in normalized row records. The original file digest is retained to support audit and exact replay detection.

## Idempotency and tenant isolation

A batch is unique by merchant, store, provider, and external batch identifier. Re-importing the same batch with the same digest, currency, row count, and totals is an idempotent replay. Reusing the identity with different content fails with a conflict. Each row is keyed by batch and row number and stores a canonical SHA-256 digest; changed content at an existing row number is rejected.

Batch insertion and all row writes run in one database transaction. The summary lookup is scoped by merchant, store, and batch ID. No client-supplied merchant/store scope should be trusted by a future HTTP controller.

## Reconciliation lifecycle

Rows begin in `pending`. The schema reserves `matched`, `unmatched`, `ambiguous`, and `exception` states for a later matching engine and operator workflow. This stage intentionally does not guess which journal account, provider reference, settlement fee, or transaction state constitutes a match.

## Deployment

The two tables are created additively during normal database initialization. Before production use, deploy to staging, verify DB permissions for CREATE TABLE, import a redacted sample statement from each selected provider, and test backup/restore. Provider-specific file formats and financial mapping rules require official provider documentation and accounting approval.
