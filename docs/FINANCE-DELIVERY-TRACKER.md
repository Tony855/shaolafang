# Finance delivery tracker

Last reviewed: 2026-11-14 (main baseline `41d0517b`; finance reconciliation acceptance remains delivered; PR #234 is merged and the current non-finance PR #238 is tracked separately below)

This tracker records merged delivery separately from work that is still under review. It is a capability inventory, not a percentage-complete estimate.

**Database test-scope note:** MariaDB 10.5 and 10.11 have both passed the complete repository test suite plus isolated finance integration and backup/restore suites (PR #227/#228). MySQL 8.4 remains an additional independent integration target.

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
| MariaDB finance integration compatibility | Real-database finance integration and backup/restore suites pass on MariaDB 10.5 and 10.11; complete repository test suite also passes in the same matrix | PR #227 and #228 merged; PR #228 commit `d793670be103ec3f1eac9a1d0355ea4a1f095b15`; all eight final-head checks passed |
| Manual-review idempotency concurrency | Non-locking idempotency preflight, period/batch lock ordering, current replay recheck and closed-month replay behavior | PR #199 merged as `247fb33b`; CI and installer checks passed |
| Concurrent journal assignment protection | Two independent MySQL transactions attempt to confirm different statement rows against one journal transaction; only one may commit and the loser writes no audit event | PR #200 merged as `0c7a5f57`; final-head CI and review passed |

## Under review

- No finance implementation pull requests are currently open. PR #238 is a separate database CI/documentation matrix change (MariaDB 10.11/11.4/11.8/12.3); it is not a finance-reconciliation dependency. Existing MariaDB 10.5/10.11 and MySQL 8.4 results remain as recorded until #238's own final-head checks pass.

## Remaining engineering acceptance work

1. **End-to-end lifecycle regression — core acceptance complete:** PR #196 covers import → journal → suggestion → manual review → month close → export; PR #197 covers imported exception → SLA → resolution; PR #205 covers confirm/release/reconfirm/reassign/reject; PR #207 covers real-MySQL refund/fee/settlement-difference classification. Separate scenarios preserve clear transaction boundaries. PR #200 covers the concurrent journal-assignment race.
2. **Authorization matrix — core acceptance complete:** PR #204 exercises every registered finance read/history/export/summary/SLA/month-close route, validates every financial SQL read against authenticated merchant/store scope, and rejects spoofed tenant/actor IDs across every registered finance mutation route. Foreign resource IDs and cross-merchant assignee protections are covered by PR #176/#179/#180; export audit scopes by PR #182/#183/#184.
3. **Data-volume validation — 50k acceptance complete:** PR #166 adds a 2,500-row synthetic pagination correctness test. PR #201 adds the legacy-safe tenant/status/cursor index and real-MySQL 2,500/10,000/50,000-row benchmark. PR #206 extends the 50k case across five batches with mixed categories and pending rows, and verifies category/case-state filters and tenant-store exclusion. Loads above 50k remain an optional capacity exercise, not a blocker for the scoped release.
4. **Currency and rounding audit — core precision acceptance complete:** PR #185 protects period/month aggregates. PR #203 adds fail-closed safe-integer validation for persisted statement/journal amounts, matching suggestions, exception/SLA views, batch list, journal CSV export, batch replay and journal replay. Provider-specific currency mapping and rounding remain blocked on merchant-specific account configuration and finance approval.
5. **Operational recovery — acceptance complete:** PR #186 adds a real-MySQL conflicting-import rollback/replay slice. PR #187 adds populated-database migration rerun/retention coverage. PR #188 adds concurrent month-close lock exclusivity. PR #202 adds full reconciliation/audit/month-close backup and restore coverage, legacy backup compatibility, FK ordering, and interrupted-restore rollback.
6. **Provider integration boundary:** official public PayWay callback-signature and Bakong Open API specifications have been located and read-only verification helpers are merged. End-to-end activation still requires merchant-specific sandbox credentials, verified outlet/receiver account mapping, callback whitelisting, current outbound request-signing details, and finance-approved amount/currency/order transition rules. Keep live callbacks and settlement automation disabled until those items are tested.

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
- PR #204 merged: authenticated scope matrix for every finance read route and actor spoofing rejection for all finance mutation routes (`971c70c4e9f902f7dc980997affbc4d22c0102b3`); 572 tests, 555 passed, 0 failed, 17 skipped; MySQL and four OS installer matrices passed.
- PR #205 merged: real-MySQL confirm/release/reconfirm/reassign/release/reject sequence, idempotent replay, and recomputed immutable audit hashes (`94a8366d2c63ade9915e7f8c9dcedf825f005698`); final-head CI and all four installer targets passed.
- PR #206 merged: real-MySQL 50k exception queue across five batches with mixed categories, pending rows, resolved-case filters, and tenant/store isolation (`f03df316c44124459bf6a5547daef08d2d51b9bb`); full CI and four installer targets passed.
- PR #207 merged: real-MySQL manual classification for refund, fee, and settlement difference; verifies original statement amounts remain unchanged, exact replay is idempotent, and audit events are hash-linked (`3d8c3f386add3a4a65c9cf3566f25feb4a06f5ef`); 573 tests, 555 passed, 0 failed, 18 skipped; 17/17 MySQL integration tests passed; all four installer targets passed.
- PR #209 merged: classification audit tests now compare persisted reviewer username, reason, category, and complete before/after snapshots against the submitted request (`37ca397aac5264121cdb670f13e3536a16ab1e6a`); final-head CI and all four installer targets passed.
- **Stage 10 closeout (historical):** provider-neutral finance review and reconciliation core acceptance tests were merged. Subsequent PR #211 and #213 added official-spec-based read-only ABA PayWay/Bakong verification and strict Bakong batch handling. Live callbacks, automatic settlement, provider notifications, currency/FX mapping, and rounding remain gated on merchant credentials, current outbound request-signing details, and finance approval.
- PR #210 merged: remove the duplicate MySQL backup/restore test invocation and repair two literal newline escapes in the reconciliation API list; latest PR-head CI and all four installer targets passed.
- PR #211 merged: official-spec-based read-only ABA PayWay callback HMAC authentication and Bakong dynamic-KHQR MD5 transaction lookup, including request timeout, strict response validation, and deterministic tests; no live credentials, callback route, order settlement, refund mutation, or journal posting activated.
- PR #213 merged: enforce the exact NBC MD5-list response status set (SUCCESS, NOT_FOUND, STATIC_QR), retain FAILED only for the single-digest API, and add a negative contract test.
- PR #214 merged: align the delivery tracker with the merged Bakong contract hardening and keep live provider activation gates explicit.
- PR #215 merged: reconcile the historical Stage 10 closeout note with later provider-adapter delivery and distinguish code completion from live activation gates.
- PR #216 merged: clarify that provider currency/rounding remains gated by merchant account configuration and finance approval, not by missing public API specifications.
- PR #218 merged: rename the PayWay callback status output to callbackStatusCode and document that status=0 is the callback request status, not proof of final payment success.
- PR #219 merged: close the PayWay callback status review item after the latest-head test and installer matrices passed.
- Production deployment and live financial operations: not performed.

## Progress update protocol

For each batch, update this tracker with the merged PR and commit, the open PR and current head, CI/installer status, newly covered acceptance criteria, and remaining blockers. Keep “under review” separate from “delivered to main”.

- PR #201 merged: legacy-safe tenant/status/cursor index plus real-MySQL 2.5k/10k/50k benchmark and 50k pagination walk (`fcb3d0bdbaedebf8f1cb297ac2f9da7e878c8af2`).
- PR #202 merged: complete financial reconciliation, journal, exception/SLA, and month-close backup/restore table graph; parent-first restore and child-first delete ordering; legacy backup compatibility and MySQL recovery tests (`96aa43acb89ff2346b350ca5b95dbb340c5d3a22`).

- MariaDB compatibility batch started from main `4e58ad707bb8df60763b07dd3033ee3c97bc3227`: adding dedicated MariaDB 10.5/10.11 service-container runs for the existing real-database finance integration and backup/restore suites. Results remain pending until the PR head's complete CI matrix passes; no MariaDB compatibility claim is made before then.

- PR #227 merged: MariaDB 10.5 and 10.11 each passed the real-database finance integration and backup/restore test files; MySQL 8.4 and all four installer compatibility targets also passed (`fce81badd92475d087e5662e8aca1c4eef13830a`). Follow-up PR expands the MariaDB job to the complete repository test suite.

- PR #228 merged: full repository test suite passes, followed by the finance integration and backup/restore suites in deterministic sequence on MariaDB 10.5 and 10.11; MySQL 8.4 and all four installer compatibility targets also passed (`d793670be103ec3f1eac9a1d0355ea4a1f095b15`). The CI test command now invokes the defined npm test script directly. Database integration fixtures remain sequential because they intentionally reuse a dedicated schema and perform table cleanup.


- PR #230 merged: provider event failure/retry row-lock read and state transition now share one transaction; 12/12 current-head CI and installer checks passed. Merge commit: `f4dd39818074f1e8bf8b36028c5476d43fead9ee`.
- PR #231 merged: expired verified provider events that have consumed their final attempt are now retired as `failed` after lease expiry instead of remaining stranded in `processing`; 12/12 current-head CI and installer checks passed. Merge commit: `7d3beaa552911365dd2bc3f9814563fd209760e3`.
- PR #232 merged: add legacy-safe indexes for due-received and expired-lease queue claim paths; validate schema drift and concurrent startup migration races. MySQL 8.4, MariaDB 10.5/10.11, and Ubuntu 22.04/24.04 plus Debian 12/13 passed (8/8 current-head checks). Merge commit: `a9c1e32e17c8936eecd9914997c3b3c189a3d5db`.
- PR #233 merged: fence expired provider-event leases so a worker cannot complete or schedule failure after its lease deadline, even before another worker reclaims the event; re-check expiry at the final failure-state update to close the lock-to-update timing window. Adds bounded 5–900 second lease renewal that cannot revive an expired lease. Current-head 12/12 checks passed, including MySQL 8.4, MariaDB 10.5/10.11, full repository tests, and four installer targets. Merge commit: `1b70f7bbd0ee79e61b36de78e5f2d1ec350b6d56`.
- PR #234 merged: require the provider transaction reference to match exactly between the event envelope and normalized event; reject mismatched or one-sided references before transaction/inbox persistence. Regression tests cover both mismatch directions and matching-reference acceptance. Merge commit: `0fcb6e25e05de1662541418a2998af699ce76d42`.
- Current collaboration snapshot: `main` is `41d0517b3456889f51d5893bdcbbe60d1c29e540` (PR #237). PR #238 is open at head `c2e1ce3ff990c064143f756b866d11726f2a13c0`, targets that main baseline, and changes only the MariaDB CI/documentation matrix; it is not a finance code dependency.
