# Finance delivery tracker

Last reviewed: 2026-11-12 (PR #184 merged; exception-performance export audit filters are tenant-scoped; PR #185 adds safe aggregate precision guards)

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
| Month-close MySQL integration | Real MySQL 8.4 schema creation, merchant-scoped period uniqueness, idempotency uniqueness, and `SELECT ... FOR UPDATE` lock behavior | PR #177 merged as `702b9d72` |
| Exception/SLA MySQL integration | Real MySQL 8.4 exception workflow and SLA schema creation, foreign-key enforcement, tenant-separated cases/events, and idempotency uniqueness | PR #178 merged as `1f6bd83d` |
| Authenticated foreign-resource protection | Foreign review item IDs, SLA alert acknowledge/dismiss IDs, and exception workflow item IDs are rejected without state/audit writes | PR #176 and #179 merged |
| Cross-merchant exception assignee protection | Exception assignment verifies target admin ID, authenticated merchant ID, and active status before any write | PR #180 merged as `e5f00d15`; all six CI checks passed |
| Month-close transition tenant-context protection | Spoofed request merchant/store/actor IDs are ignored; period, readiness, and audit event operations bind authenticated context | PR #181 merged as `33a13c38`; all six CI checks passed |

| Journal export tenant/audit protection | Journal and entry reads bind authenticated merchant/store; export audit records authenticated actor and tenant before CSV response | PR #182 merged as `8fad4d40`; all six CI checks passed |
| Period-report export tenant/audit protection | Period summary export uses authenticated merchant/store context and records authenticated actor, tenant, period, and row count before CSV response | PR #183 merged as `92a8fec8`; all six CI checks passed |
| Exception-performance audit filter protection | Export audit actor filters remain constrained to authenticated merchant; spoofed merchant/store/admin query IDs cannot widen scope | PR #184 merged as `a1618b17`; all six CI checks passed |
| Report aggregate precision protection | Period-report and month-close monetary aggregates reject values above JavaScript safe-integer precision rather than silently rounding | PR #185 under review; boundary regression tests added |

## Under review

- **Report aggregate precision protection:** PR #185 adds exact-safe-integer boundary and overflow regression tests for period reports and month-close previews. CI is pending.
- **MySQL-backed workflow scope:** PR #177 and #178 cover month-close and exception/SLA schema and constraint slices. A single database-backed import-to-export lifecycle remains outstanding.

## Remaining engineering acceptance work

1. **End-to-end lifecycle regression:** import → match suggestions → manual review → exception workflow → SLA alert → month-close preview/approval → export/audit. Month-close migration/locking and exception/SLA schema/constraint slices are database-backed; a single database-backed full-flow scenario across all services remains outstanding.
2. **Authorization matrix:** route-wide middleware wiring and missing-context rejection are covered (PR #172); representative authenticated read-query scoping is covered (PR #173); review mutation and audit query scoping is covered by PR #174; foreign review/SLA/exception workflow resource IDs are covered by PR #176/#179; cross-merchant exception assignee ownership is covered by PR #180; month-close transition context is covered by PR #181. Journal and period-report export audit scopes are covered by PR #182/#183; exception-performance audit filter spoofing is covered by PR #184. Remaining export/admin ownership cases still need explicit acceptance tests.
3. **Data-volume validation:** PR #166 adds a 2,500-row synthetic pagination correctness test. Still benchmark realistic database-backed batches/queues at 2,500, 10,000, and 50,000 rows, inspect query plans before adding indexes, and document measured response times.
4. **Currency and rounding audit:** PR #185 adds safe-integer guards for period/month aggregate minor-unit totals. Continue auditing every financial path for integer minor-unit consistency, currency separation, explicit precision, and prevention of cross-currency aggregation.
5. **Operational recovery:** test backup/restore, migration/startup schema ensure, interrupted imports, retry behavior, and month-close lock recovery.
6. **Provider integration boundary:** keep bank/payment provider verification and external notifications disabled until real credentials, signature verification rules, supported currencies, and delivery policies are explicitly supplied and tested.

## Release gates

- Merge only when the latest PR head has all CI and installer compatibility checks green and no blocking review state.
- Never merge based on checks for an older commit.
- No production deployment, real payment/refund execution, or accounting posting is part of these repository-only development batches.
- Do not claim a global completion percentage until each capability above has explicit acceptance tests and evidence.

## Latest batch status

- PR #176 merged: valid-session foreign resource-ID probing for review items and SLA alert acknowledge/dismiss (`e19cd0c5`). All five PR-head checks passed.
- PR #177 merged: dedicated MySQL 8.4 integration job for month-close migration, tenant-specific periods, per-period idempotency uniqueness, and row-lock behavior (`702b9d72`). All six PR-head checks passed.
- PR #178 merged: MySQL 8.4 exception workflow/SLA migration, foreign-key, tenant-separation, and idempotency tests (`1f6bd83d`). All six PR-head checks passed.
- PR #179 merged: valid-session foreign exception-item ID transition denial with tenant-scoped item lookup and no case/audit writes (`8a672ada`). All six PR-head checks passed.
- PR #180 merged: cross-merchant exception assignee rejection using an explicit tenant-scoped active-admin lookup (`e5f00d15`). All six PR-head checks passed.
- PR #181 merged: month-close transition route ignores spoofed tenant/actor request IDs and uses authenticated context throughout (`33a13c38`). All six PR-head checks passed.
- PR #182 merged: journal export route test verifies authenticated tenant/store SQL scoping and durable export audit metadata (`8fad4d40`); all six checks passed.
- PR #183 merged: period-report export route test verifies authenticated tenant/store SQL scoping and durable export audit metadata (`92a8fec8`); all six checks passed.
- PR #184 merged: exception-performance export audit filters are tested against spoofed tenant/store/admin query IDs and foreign-merchant actor filters (`a1618b17`); all six checks passed.
- PR #185 open: period-report and month-close preview reject aggregate minor-unit totals above `Number.MAX_SAFE_INTEGER`; exact-boundary totals remain supported. CI pending.
- Production deployment and live financial operations: not performed.

## Progress update protocol

For each batch, update this tracker with the merged PR and commit, the open PR and current head, CI/installer status, newly covered acceptance criteria, and remaining blockers. Keep “under review” separate from “delivered to main”.
