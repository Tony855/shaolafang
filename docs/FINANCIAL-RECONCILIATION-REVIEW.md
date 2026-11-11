# Financial reconciliation review workflow

## API

All endpoints require an authenticated merchant administrator with the dedicated `can_manage_financial_reconciliation` permission. The current request must be scoped to one active store; cross-store/all-store context is rejected.

- `GET /api/admin/financial-reconciliation/batches/:batchId/items`: returns statement rows and provider-neutral match suggestions. Supports cursor pagination with `limit` (1–500) and `afterRowNo`; follow the returned `nextCursor` until null. Suggestions are advisory only.
- `POST /api/admin/financial-reconciliation/items/:itemId/review`: performs `confirm`, `reject`, `release`, or `reassign`, or `classify_exception`. Supply `batchId`, `action`, `reason`, and a unique `Idempotency-Key` header. A provider-neutral import endpoint is also available at `POST /api/admin/financial-reconciliation/batches/import`; it accepts normalized rows and a statement SHA-256 digest, not raw proprietary bank files. Confirm/reassign also require `journalTransactionId`. Exception classification requires `exceptionCategory` (refund, fee, settlement_difference, chargeback, other).
- `GET /api/admin/financial-reconciliation/daily-summary?from=YYYY-MM-DD&to=YYYY-MM-DD`: returns per-day, per-currency batch totals and match-state counts for a maximum 91-day window.

## Review invariants

- Tenant and store IDs come exclusively from the authenticated administrator context, never from the request body.
- The service locks the batch, item, and target journal header inside the repository's transaction helper. The existing AsyncLocalStorage helper reuses the active MySQL connection and nested savepoints.
- A manual assignment requires exact currency and exact balanced debit/credit totals equal to the statement amount in integer minor units. Direction mapping is not guessed.
- A unique index on `financial_reconciliation_items.matched_journal_transaction_id` prevents assigning one journal transaction to multiple statement rows. The migration checks existing duplicates before creating the index and fails closed if conflicts require operator review.
- Review writes require an idempotency key. Exact replay returns the original event; key reuse with changed request data is rejected.
- Each review event records actor, reason, before/after state, exception category where applicable, request digest, previous event hash, and event hash. Events are append-only at the application service boundary and hash-linked per batch. Database operators should grant the application account INSERT/SELECT but not UPDATE/DELETE on this audit table where the deployment permission model allows it.

## Status behavior

- `confirm`: assigns one eligible journal transaction and sets `match_status=matched`.
- `reject`: records a reason and sets `match_status=unmatched`; a previously matched item must first be released.
- `release`: clears a current assignment and returns the item to `pending`.
- `reassign`: replaces the journal transaction on an already matched item after validating the new candidate.

Closed batches are immutable. This phase does not automatically close batches, post journal entries, change orders, confirm provider payments, or mutate refund balances.

## Daily exception reporting

Daily summaries expose imported batch totals and counts for matched, pending, unmatched, ambiguous, and exception rows, including refund, fee, settlement-difference, and chargeback and other exception counts. Refund, fee, settlement-difference and chargeback categories are stored on each manually classified exception for drill-down. Refund, fee, settlement and chargeback classification remains manual/provider-neutral; no provider-specific bank semantics or chart-of-accounts policy is inferred.

## Backward-compatible startup migration

The startup migration creates the review-event table if absent, checks for existing duplicate journal assignments, and adds the unique assignment index only when missing. It does not rebuild statement batches, rewrite existing match statuses, backfill old orders, or run on a production host as part of this code change.
