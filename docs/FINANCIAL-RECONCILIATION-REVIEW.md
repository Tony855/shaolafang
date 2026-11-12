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


## Finance exception handling workflow

The exception queue also exposes a case workflow. Each case is unique to a merchant, store, and statement item. The workflow status is separate from the underlying statement match status:

- `open` → `in_progress` → `resolved` → `closed`
- `resolved` and `closed` cases may be reopened to `open`.
- Active merchant administrators can be assigned or unassigned while a case is not closed.
- Notes are append-only events. A resolution requires a 5–500 character reason, retained as the case's current resolution note.
- Every workflow action requires a 12–128 character idempotency key and a 5–500 character reason. The event is written in the same transaction as the case update.
- Events have before/after snapshots, actor identity, request digest, previous hash, and event hash. The event history is append-only and hash-linked per statement item.
- `GET /api/admin/financial-reconciliation/exceptions` accepts `status=open|in_progress|resolved|closed` in addition to the existing category/date/pagination filters.
- `POST /api/admin/financial-reconciliation/exceptions/:itemId/workflow` accepts `batchId`, `action`, `reason`, `idempotencyKey`, and `assignedAdminId` for the `assign` action.

The workflow does not change statement amounts, journal entries, orders, refunds, or payment settlement state. It does not certify an accounting resolution or create a ledger posting. All operations reuse the existing financial reconciliation permission and tenant/store context.

- `GET /api/admin/financial-reconciliation/exceptions/:itemId/history?batchId=...&limit=50&afterId=0` returns the item's append-only workflow events in descending cursor pages, including before/after snapshots and hash-chain fields.


## Exception operations monitoring (Phase 16)

- `GET /api/admin/financial-reconciliation/exceptions/operations-summary?slaHours=24` returns a read-only operations snapshot for the authenticated merchant and active store.
- SLA hours are an explicit query parameter (integer 1–720); the UI default is 24 hours and is an operational display threshold, not a provider settlement or accounting rule. SLA age starts at the statement batch `imported_at` timestamp.
- Summary counts include open/in-progress cases, overdue active cases, and ageing bands (<24 hours, 1–3 days, 3–7 days, >7 days). Cases without a workflow row are treated as open, matching the exception queue.
- Workload is grouped by assignee; unassigned workload is returned as a null-assignee row. Data remains limited to the authenticated merchant and active store.
- The 30-day trend reports exception statement rows by batch import date and immutable `resolve` events by event date. Resolution counts are event counts, not unique-case counts.
- The overdue list is capped at 50 oldest active exceptions. It is an in-console reminder queue only; this phase does not send email, SMS, Telegram, push notifications, or invoke external providers.
- All queries are read-only, use bound parameters, join batch/case ownership on merchant and store IDs, and return private no-store responses. No statement, payment, refund, journal, ledger, or month-close mutation is performed.


## SLA alert inbox and reporting presets (operations batch)

- Finance administrators can generate durable in-app SLA alerts for active overdue exceptions. Each run scans up to 500 oldest active exceptions for the selected threshold (1–720 hours).
- Alert deduplication is enforced by a database unique key over merchant, store, statement item, alert type, and SLA threshold. Re-running generation does not create duplicate alerts.
- Acknowledging an alert is separate from resolving an exception. It requires a 5–500 character reason and an idempotency key, is tenant/store scoped, and appends a hash-linked immutable event.
- The workbench provides report date presets for the last 7 days, last 30 days, and current calendar month. They use the existing daily summary endpoint and CSV export.
- The inbox is in-app only. No Telegram, email, SMS, push, or webhook is sent; external delivery requires operator-provided credentials, endpoint policy, and delivery acceptance rules.
- Alert acknowledgement does not modify statement rows, payments, refunds, journals, ledger entries, or month-close state.
- Startup schema ensure creates the alert and event tables. No production deployment or production migration was performed.

### SLA alert dismissal

- Pending SLA alerts may be dismissed through `POST /api/admin/financial-reconciliation/exceptions/alerts/:alertId/dismiss`.
- Dismissal requires a 5–500 character reason and a 16–128 character idempotency key (body field or `Idempotency-Key` header).
- The operation is scoped to the active merchant/store, locks the alert row, rejects non-pending alerts, and appends a hash-linked `dismissed` event in the same transaction.
- Dismissing an alert does not resolve, close, reclassify, or otherwise mutate its underlying reconciliation exception. External notifications remain disabled.

### SLA alert audit history and period reports

- The alert inbox can filter pending, acknowledged, dismissed, or all alerts. Each alert exposes a tenant/store-scoped, cursor-paginated audit history with actor, action, reason, timestamp, and event hash.
- Weekly and monthly summaries aggregate statement batches by period and currency, retaining amounts in their original currency minor units. No cross-currency conversion or financial posting is performed.
- Period summaries accept a maximum 366-day date range and are available through `GET /api/admin/financial-reconciliation/period-summary?period=week|month&from=YYYY-MM-DD&to=YYYY-MM-DD`.
- Alert history is available through `GET /api/admin/financial-reconciliation/exceptions/alerts/:alertId/history`. Both endpoints are finance-authenticated, tenant/store scoped, and non-cacheable.


## Exception performance metrics (next operations batch)

- Read-only endpoint: `GET /api/admin/financial-reconciliation/exceptions/performance-summary?slaHours=24` (SLA threshold: integer 1–720 hours).
- The response separates currencies and reports active/overdue exception counts and overdue rate by currency, assignee, and exception category. Unassigned work is retained as a null-assignee group.
- On-time resolution rate is calculated from immutable `resolve` event counts: elapsed time is measured from the statement batch `imported_at` to each event's `created_at`. Reopened cases resolved again contribute another event; the metric is explicitly event-based, not unique-case based.
- Average import-to-resolve time uses the same timestamps. It is not a measure of time since an employee began work and must not be described as net handling time.
- SLA rate denominators are explicit: overdue rate uses currently active open/in-progress exception rows; on-time resolution rate uses recorded resolve events. Empty denominators return `null`, not 0%.
- All queries use authenticated merchant/store IDs and bound parameters, group by original currency, return private no-store responses, and do not mutate reconciliation, order, payment, refund, journal, ledger, or month-close records.


### Exception performance workbench UI

- The admin finance workbench renders the performance summary API in separate currency, assignee, and exception-category tables.
- The selected SLA threshold is shared with the exception operations monitor; the performance panel can be refreshed independently.
- CSV export combines the three groupings into one file, retains original currency codes, and escapes spreadsheet formula-prefixed cells.
- The UI labels the resolution rate as event-based and elapsed time as import-to-resolve, not employee net handling time. Export is an on-demand browser download; server-side export audit has not yet been introduced.
