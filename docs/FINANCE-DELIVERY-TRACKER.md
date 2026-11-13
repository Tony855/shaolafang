# Finance delivery tracker

Last reviewed: 2026-11-13 (PR #203–#205 merged; authenticated finance route scope and full manual-review action sequence delivered; PR #206 multi-batch capacity validation under review)

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
| Report aggregate precision protection | Period-report and month-close monetary aggregates reject values above JavaScript safe-integer precision rather than silently rounding; exact safe boundary remains supported | PR #185 merged as `8643a579`; all six PR checks passed |
| MySQL statement import transaction | Real-MySQL batch import, exact replay idempotency, conflicting row replay rejection, and rollback preserving original row contents | PR #186 merged as `c7244af8`; all six checks passed |
| MySQL migration rerun safety | Month-close, exception-workflow, and SLA schema ensure functions can be rerun on populated tables without deleting tenant data or event history | PR #187 merged as `68973f6a`; all six checks passed |
| MySQL month-close concurrency | Two independent transactions contend for one open period; only one can lock it, and the competing transaction observes `FINANCIAL_MONTH_LOCKED` | PR #188 merged as `3133f88a`; all six checks passed |
| MySQL journal posting | Real-MySQL balanced journal posting, exact idempotent replay, and changed header/entry replay rejection | PR #189 merged as `6c480ce1`; all six checks passed |
| MySQL journal export scope | Real-MySQL journal export returns the selected merchant/store rows and excludes other merchants and stores | PR #190 merged as `501f9a04`; all six checks passed |
| MySQL matching suggestion scope | Real-MySQL candidate query plus matching logic returns only exact reference/amount/currency candidates for the authenticated merchant/store; suggestions do not mutate rows | PR #191 merged as `b2f43c97`; all six checks passed |
| MySQL manual review transaction | Real-MySQL review confirms exact journal matches, preserves exact replay idempotency, and rejects amount mismatch without changing the row or writing an audit event | PR #192 merged as `670a14a8`; all six checks passed |
| MySQL exception workflow transaction | Real-MySQL exception case start/resolve transitions persist actor, status, resolution note, idempotent event replay, and linked event hashes | PR #193 merged as `b32cf765`; all six checks passed |
| MySQL SLA alert lifecycle | Real-MySQL overdue alert generation is deduplicated; acknowledge/dismiss transitions are idempotent and preserve hash-linked alert history | PR #194 merged as `563b46b3`; all six checks passed |
| MySQL month-close approval lifecycle | Real-MySQL close request enforces maker-checker; readiness failure rolls back and retry succeeds; approval history remains hash-linked | PR #195 merged as `4369409a`; all six current-head checks passed |
| MySQL cross-service import-to-export lifecycle | Real-MySQL statement import flows through journal posting, candidate suggestion, manual review, month-close approval, and scoped CSV export | PR #196 merged as `6e1cfefb`; all six checks passed |
| MySQL imported-exception-to-SLA lifecycle | Real-MySQL imported unmatched row is classified, moved into an exception case, becomes SLA-overdue, is acknowledged, and is resolved with hash-linked histories | PR #197 merged as `3f7728db`; all six checks passed |
| Manual-review idempotency concurrency | Non-locking idempotency preflight, period/batch lock ordering, current replay recheck and closed-month replay behavior | PR #199 merged as `247fb33b`; CI and installer checks passed |
| Concurrent journal assignment protection | Two independent MySQL transactions attempt to confirm different statement rows against one journal transaction; only one may commit and the loser writes no audit event | PR #200 merged as `0c7a5f57`; final-head CI and review passed |

## Under review

- **Authenticated finance scope matrix:** PR #204 exercises all finance read/history/export/summary/SLA/month-close routes against authenticated merchant/store context, scans serialized tenant filters for spoofed IDs, and verifies mutation routes reject body/query actor spoofing before database access.
- **MySQL-backed workflow scope:** PR #177/#178 cover month-close and exception/SLA schema/constraint slices; PR #186–#197 cover import, migration reruns, locking, journal posting/export, matching, review, exception/SLA, month-close and cross-service paths. PR #199 hardens exact review replay under concurrency. Remaining work is tracked below.

## Remaining engineering acceptance work

1. **End-to-end lifecycle regression:** import → match suggestions → manual review → exception workflow → SLA alert → month-close preview/approval → export/audit. PR #196 covers import-to-close-export; PR #197 covers imported-exception-to-SLA. These are distinct business branches, not yet one shared scenario covering every possible outcome. PR #200 separately verifies the concurrent journal-assignment race against real MySQL.
2. **Authorization matrix:** route-wide middleware wiring and missing-context rejection are covered (PR #172); PR #204 now exercises all registered finance read/history/export/summary/SLA/month-close routes, validates every financial SQL read against authenticated merchant/store scope, and rejects spoofed tenant/actor IDs across every registered finance mutation route. Foreign resource IDs and cross-merchant assignee protections remain covered by PR #176/#179/#180; export audit scopes by PR #182/#183/#184.
3. **Data-volume validation:** PR #166 adds a 2,500-row synthetic pagination correctness test. PR #201 adds the legacy-safe tenant/status/cursor index and real-MySQL 2,500/10,000/50,000-row benchmark. PR #206 extends the 50k case across five batches with mixed categories and pending rows, and verifies category/case-state filters and tenant-store exclusion. Loads above 50k remain an optional capacity exercise.
4. **Currency and rounding audit:** PR #185 protects period/month aggregates. PR #203 is merged with fail-closed safe-integer validation for persisted statement/journal amounts, matching suggestions, exception/SLA views, batch list, journal CSV export, batch replay and journal replay. Remaining checks are limited to provider-specific currency semantics, which require official provider and finance approval.
5. **Operational recovery:** PR #186 adds a real-MySQL conflicting-import rollback/replay slice. PR #187 adds populated-database migration rerun/retention coverage. PR #188 adds concurrent month-close lock exclusivity. PR #202 adds full reconciliation/audit/month-close backup and restore coverage; final-head MySQL restore/rollback checks remain required before this gate is complete.
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
- PR #185 merged: period-report and month-close preview reject aggregate minor-unit totals above `Number.MAX_SAFE_INTEGER` while preserving exact safe-boundary values (`8643a579`); all six PR checks passed.
- PR #186 merged: real-MySQL statement import replay, conflicting row detection, and transaction rollback (`c7244af8`); all six checks passed.
- PR #187 merged: rerun month-close, exception-workflow, and SLA schema ensure against populated MySQL tables and verify existing tenant rows/events remain intact (`68973f6a`); all six checks passed.
- PR #188 merged: two independent MySQL transactions contend for the same month-close period; one transition wins, the other receives `FINANCIAL_MONTH_LOCKED`, and one unique period row remains (`3133f88a`); all six checks passed.
- PR #189 merged: real-MySQL balanced journal posting, exact idempotent replay, and changed header/entry replay rejection (`6c480ce1`); all six checks passed.
- PR #190 merged: real-MySQL journal CSV export is scoped to one merchant/store and excludes other merchant/store entries (`501f9a04`); all six checks passed.
- PR #191 merged: real-MySQL reconciliation matching query verifies candidate isolation by merchant/store, exact reference, amount, and currency, while leaving statement rows pending (`b2f43c97`); all six checks passed.
- PR #192 merged: real-MySQL manual review verifies exact journal confirmation, idempotent replay, and rejection of mismatched amount without row/audit mutation (`670a14a8`); all six checks passed.
- PR #193 merged: real-MySQL exception workflow verifies start/resolve state transitions, idempotent replay, actor attribution, resolution note, and linked event hashes (`b32cf765`); all six checks passed.
- PR #194 merged: real-MySQL SLA alert generation, duplicate suppression, acknowledge/dismiss replay, and hash-linked history (`563b46b3`); all six checks passed.
- PR #195 merged: real-MySQL month-close request/approval, maker-checker, readiness rollback/retry, and hash-linked history (`4369409a`); all six checks passed.
- PR #196 merged: real-MySQL import → journal posting → match suggestion → manual review → month-close approval → CSV export in one cross-service scenario (`6e1cfefb`); all six checks passed.
- PR #197 merged: real-MySQL import → exception classification → case start → SLA alert generation/acknowledgement → case resolution, with linked event histories (`3f7728db`); all six checks passed.
- PR #199 merged: manual-review idempotency gap-lock/deadlock hardening, exact replay after close, and two-connection MySQL replay test (`247fb33b225eec07f05987b68cc0264a5c719ba9`); CI and installer compatibility checks passed.
- PR #200 merged: real-MySQL two-connection race proves one Ledger transaction cannot be assigned to two statement rows; the loser leaves no review event (`0c7a5f5752d262c60033c0163d08d17fce6a0e7c`); final-head CI and Codex review passed.
- PR #201 merged: legacy-safe tenant/status/cursor index, real-MySQL 2.5k/10k/50k benchmark and complete 50k cursor walk; final EXPLAIN selected the intended index (`fcb3d0bdbaedebf8f1cb297ac2f9da7e878c8af2`).
- PR #202 merged: full financial backup/restore graph, legacy backup compatibility, JSON-column restore serialization, FK order and MySQL interrupted-restore rollback (`96aa43acb89ff2346b350ca5b95dbb340c5d3a22`).
- PR #203 merged: exact integer minor-unit validation across review, exception/SLA, batch list, journal CSV, batch replay and journal replay; real MySQL overflow tests reject before mutation (`dda087c59370ba5efc800a6117e89946d7cd0ad9`).
- PR #204 open: authenticated tenant/store and actor spoofing matrix across finance read/export/history/mutation routes; final-head CI and review pending.
- Production deployment and live financial operations: not performed.

## Progress update protocol

For each batch, update this tracker with the merged PR and commit, the open PR and current head, CI/installer status, newly covered acceptance criteria, and remaining blockers. Keep “under review” separate from “delivered to main”.

- PR #201 merged: legacy-safe tenant/status/cursor index plus real-MySQL 2.5k/10k/50k benchmark and 50k pagination walk (`fcb3d0bdbaedebf8f1cb297ac2f9da7e878c8af2`).
- PR #202 open: complete financial reconciliation, journal, exception/SLA, and month-close backup/restore table graph; parent-first restore and child-first delete ordering; legacy backup compatibility and MySQL recovery tests; CI pending.
