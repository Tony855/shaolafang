# Financial reconciliation review workflow

## API

All endpoints require an authenticated merchant administrator with the dedicated `can_manage_financial_reconciliation` permission. The current request must be scoped to one active store; cross-store/all-store context is rejected.

- `GET /api/admin/financial-reconciliation/batches/:batchId/items`: returns statement rows and provider-neutral match suggestions. Supports cursor pagination with `limit` (1–500) and `afterRowNo`; follow the returned `nextCursor` until null. Suggestions are advisory only.
- `POST /api/admin/financial-reconciliation/items/:itemId/review`: performs `confirm`, `reject`, `release`, or `reassign`, or `classify_exception`. Supply `batchId`, `action`, `reason`, and a unique `Idempotency-Key` header. A provider-neutral import endpoint is also available at `POST /api/admin/financial-reconciliation/batches/import`; it accepts normalized rows and a statement SHA-256 digest, not raw proprietary bank files. Confirm/reassign also require `journalTransactionId`. Exception classification requires `exceptionCategory` (refund, fee, settlement_difference, chargeback, other).
- `GET /api/admin/financial-reconciliation/daily-summary?from=YYYY-MM-DD&to=YYYY-MM-DD`: returns per-day, per-currency batch totals and match-state counts for a maximum 91-day window.\n- `GET /api/admin/financial-reconciliation/review-history?batchId=&itemId=&limit=50&afterId=0`: returns append-only manual review events, newest first, with tenant-scoped filters and descending event-ID cursor pagination (maximum 200 per page).\n- `GET /api/admin/financial-reconciliation/monthly-close-preview?month=YYYY-MM`: returns per-currency monthly statement totals, batch states, match counts, and unresolved-row counts. The preview is read-only; `closeReady` means all imported statement rows for that currency/month are matched, not that an accounting close has been posted.

## Review invariants

- Tenant and store IDs come exclusively from the authenticated administrator context, never from the request body.
- The service locks the batch, item, and target journal header inside the repository's transaction helper. The existing AsyncLocalStorage helper reuses the active MySQL connection and nested savepoints.
- A manual assignment requires exact currency and exact balanced debit/credit totals equal to the statement amount in integer minor units. Direction mapping is not guessed.
- A unique index on `financial_reconciliation_items.matched_journal_transaction_id` prevents assigning one journal transaction to multiple statement rows. The migration checks existing duplicates before creating the index and fails closed if conflicts require operator review.
- Review writes require an idempotency key. Exact replay returns the original event only for the same authenticated admin ID; another admin reusing the key receives an idempotency conflict. The stored request digest format is unchanged so pre-existing review events remain replay-compatible. Key reuse with changed request data is rejected.
- Each review event records actor, reason, before/after state, exception category where applicable, request digest, previous event hash, and event hash. Events are append-only at the application service boundary and hash-linked per batch. Database operators should grant the application account INSERT/SELECT but not UPDATE/DELETE on this audit table where the deployment permission model allows it.

## Status behavior

- `confirm`: assigns one eligible journal transaction and sets `match_status=matched`.
- `reject`: records a reason and sets `match_status=unmatched`; a previously matched item must first be released.
- `release`: clears a current assignment and returns the item to `pending`.
- `reassign`: replaces the journal transaction on an already matched item after validating the new candidate.

Closed batches are immutable. This phase does not automatically close batches, post journal entries, change orders, confirm provider payments, or mutate refund balances.

## Monthly close approval and period lock

- `GET /api/admin/financial-reconciliation/month-close/period?month=YYYY-MM&currencyCode=USD` reads the tenant/store-scoped close state.
- `GET /api/admin/financial-reconciliation/month-close/history?month=YYYY-MM&currencyCode=USD&limit=50&afterId=0` returns the append-only approval history.
- `POST /api/admin/financial-reconciliation/month-close/transition` accepts `request_close`, `approve_close`, `reject_close`, `request_reopen`, `approve_reopen`, or `reject_reopen`. Every mutation requires a 5–500 character reason and a unique `Idempotency-Key`.
- A close request is accepted only when at least one batch exists for the imported month/currency and every statement row is matched. A second, different administrator must approve or reject the request; the requester cannot approve their own request.
- Approval moves the period to `locked`. Reopening also requires a request and approval by a different administrator. Rejecting a reopen leaves the period locked.
- New statement imports and manual reconciliation reviews acquire the same period row lock and are rejected while close approval is pending or the period is locked. Reopening approval returns the period to `open`.
- Period scope uses the existing batch `imported_at` month and stored currency code. No currency conversion, account mapping, journal posting, order mutation, refund mutation, or batch status rewrite is performed.
- Migration creates two new InnoDB tables, verifies required columns and unique indexes, and fails closed on incomplete schemas or duplicate legacy keys. Existing journal, order, refund, and reconciliation rows are not rewritten.
- Approval events are append-only in the application service: state changes update only the period row and insert a new hash-linked event. Do not grant the application database user UPDATE/DELETE on `financial_month_close_events` where the deployment permission model allows restricted grants.

## Provider-neutral journal detail export

- `GET /api/admin/financial-reconciliation/journal-export?from=YYYY-MM-DD&to=YYYY-MM-DD` exports existing journal transaction headers and debit/credit lines as CSV for the authenticated merchant and active store.
- The export reads only existing `financial_journal_transactions` and `financial_journal_entries`; it does not create accounting vouchers, post entries, alter balances, or infer account/currency policy.
- Date bounds are inclusive, limited to 31 calendar days, and queried using a half-open timestamp interval. Exports are capped at 5,000 journal lines; larger requests fail rather than silently truncating.
- Tenant and store scope are applied to both journal headers and lines. CSV cells containing spreadsheet formula prefixes are escaped to reduce formula-injection risk. Responses are private and non-cacheable.
- Amounts are emitted exactly as stored integer minor units, with the original currency code. No decimal-place, exchange-rate, or account-code mapping is inferred.

## Daily exception reporting

Daily summaries expose imported batch totals and counts for matched, pending, unmatched, ambiguous, and exception rows, including refund, fee, settlement-difference, and chargeback and other exception counts. Refund, fee, settlement-difference and chargeback categories are stored on each manually classified exception for drill-down. Refund, fee, settlement and chargeback classification remains manual/provider-neutral; no provider-specific bank semantics or chart-of-accounts policy is inferred.

## Backward-compatible startup migration

The startup migration creates the review-event table if absent, checks for existing duplicate journal assignments, and adds the unique assignment index only when missing. It does not rebuild statement batches, rewrite existing match statuses, backfill old orders, or run on a production host as part of this code change.

## Audit history and month-end preparation

- Review history is read from the immutable review-event table and is always scoped to the authenticated merchant and active store. Optional batch/item filters are validated positive IDs; pages use descending event IDs and do not expose request payloads or credentials.
- Monthly preview periods use the batch `imported_at` timestamp and group by currency. Amounts remain in stored integer minor units; the system does not infer currency decimal places, exchange rates, fee treatment, or accounting mappings.
- `closeReady` is a review-completeness indicator only: at least one batch exists and every statement row is matched. It does not post journals, mark batches closed, freeze imports, create tax/accounting vouchers, or certify a statutory month-end close.
- A monthly report with unresolved rows must be investigated. Pending, unmatched, ambiguous, and exception rows are included in the unresolved count. Closed batch count is reported separately for audit visibility.


## Finance exception queue API

- `GET /api/admin/financial-reconciliation/exceptions?category=fee&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=50&afterId=0` lists manually classified exception rows for the authenticated merchant and active store.
- Supported categories are `refund`, `fee`, `settlement_difference`, `chargeback`, and `other`. Category and date filters are optional; date filters must be supplied together and cover at most 91 inclusive calendar days.
- Results include statement-row context, provider-neutral batch identifiers, stored integer minor-unit amount/currency, exception category/note, and import timestamp. Pages are ordered by descending item ID with a stable `nextCursor`; page size is capped at 100.
- The queue is read-only. It does not create a new workflow status, assign staff, change statement rows, confirm payments, or alter refunds. Existing manual review events remain the audit source of truth. Every query joins batch ownership and filters both merchant and store; responses are private and non-cacheable.
