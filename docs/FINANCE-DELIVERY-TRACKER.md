# Finance delivery tracker

Last reviewed: 2026-11-12 (authenticated tenant query matrix merged; review mutation query hardening in review)

This tracker records merged delivery separately from work that is still under review. It is a capability inventory, not a percentage-complete estimate.

## Delivered to main

| Workstream | Delivered capability | Evidence / status |
|---|---|---|
| Ledger foundation | Provider-neutral financial ledger foundations and transactional order/refund financial records | Merged baseline |
| Reconciliation import and matching | Statement import, matching suggestions, batch/item review, and currency-aware reconciliation | Merged baseline |
| Voucher and journal exports | Audited voucher/journal CSV export with date and row limits, original currency minor units, and formula neutralization | PR #149 / #160 merged |
| Month close | Monthly close preview/workbench and maker-checker approval flow | PR #150 / #151 merged |
| Exception operations | Exception queue, workflow assignment/notes/resolution, append-only hash-linked history | PR #152 / #153 and follow-up batches merged |
| SLA operations | SLA monitoring, in-app alerts, acknowledgement/dismissal, alert history, and weekly/monthly summaries | PR #155 / #157 merged |
| Exception performance | Server-side aggregate CSV export and tenant/store-scoped export audit history | PR #161 merged |
| Unified reconciliation reporting | Daily/weekly/monthly currency-separated summaries and audited server-side CSV export | PR #162 merged as `5747068` |
| Finance authorization hardening | All finance routes require admin authentication and finance permission; inactive/expired admin sessions and inactive merchants are rejected | PR #163, #164, #170 merged |
| Reporting and pagination safeguards | Currency-preserving minor-unit totals, bounded date ranges, and 2,500-row cursor pagination correctness | PR #165 / #166 merged |
| Month-close lifecycle acceptance | Readiness failure rollback, retry after reconciliation completion, maker-checker approval, and linked audit hashes | PR #168 merged as `450436e` |

## Under review

- **Review mutation query hardening:** the duplicate journal-assignment lookup and review audit-chain head lookup now explicitly bind merchant/store scope. Regression coverage includes a foreign-tenant statement row referencing the same journal ID and verifies it cannot block a tenant-local review. Awaiting PR-head CI.
- **Cross-tenant route rejection matrix:** PR #172 is merged; every registered finance endpoint rejects request-supplied merchant/store/admin IDs when authenticated tenant context is absent. This does not prove foreign-resource denial with a valid session for every mutation/export route.

## Remaining engineering acceptance work

1. **End-to-end lifecycle regression:** import → match suggestions → manual review → exception workflow → SLA alert → month-close preview/approval → export/audit. PR #168 adds a readiness-failure/retry/second-approver month-close lifecycle test with linked audit hashes. Still add a single database-backed full-flow scenario across all services and assert transactional rollback, idempotent replay, and immutable audit history.
2. **Authorization matrix:** route-wide middleware wiring and missing-context rejection are covered (PR #172 merged); representative authenticated read-query scoping is covered (PR #173 merged). Review mutation duplicate-assignment and audit-chain queries are being explicitly tenant-scoped in the current PR. Still verify foreign-resource denial with valid sessions for every mutation/export route, including object-ID probing and assigned-admin ownership.
3. **Data-volume validation:** PR #166 adds a 2,500-row synthetic pagination correctness test. Still benchmark realistic database-backed batches/queues, inspect query plans before adding indexes, and document measured response times.
4. **Currency and rounding audit:** inspect all financial paths for integer minor-unit consistency, currency separation, explicit precision, and prevention of cross-currency aggregation.
5. **Operational recovery:** test backup/restore, migration/startup schema ensure, interrupted imports, retry behavior, and month-close lock recovery.
6. **Provider integration boundary:** keep bank/payment provider verification and external notifications disabled until real credentials, signature verification rules, supported currencies, and delivery policies are explicitly supplied and tested.

## Release gates

- Merge only when the latest PR head has all CI and installer compatibility checks green and no blocking review state.
- Never merge based on checks for an older commit.
- No production deployment, real payment/refund execution, or accounting posting is part of these repository-only development batches.
- Do not claim a global completion percentage until each capability above has explicit acceptance tests and evidence.

## Latest batch status

- Main head at batch start: `e4e5f69ff7ba47566f0b3710d0ada6658b487db9` (PR #173 merged).
- PR #172 merged: route-wide missing-authenticated-context tenant rejection matrix (`638bcbbe`).
- PR #173 merged: authenticated tenant query scoping for representative read surfaces (`e4e5f69`). All five PR-head checks passed.
- Current PR: review mutation duplicate-assignment and audit-chain SQL scope hardening; includes foreign-tenant collision regression coverage.
- CI and installer compatibility for PR #173: Debian 13, Debian 12, Ubuntu 24.04, Ubuntu 22.04, validate — 5/5 passed.
- Production deployment and live financial operations: not performed.

## Progress update protocol

For each batch, update this tracker with the merged PR and commit, the open PR and current head, CI/installer status, newly covered acceptance criteria, and remaining blockers. Keep “under review” separate from “delivered to main”.
