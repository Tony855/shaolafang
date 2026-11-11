# Refund and Payment Integrity Review

Date: 2026-11-11

Scope: review of the refund route, refund request table, waiter KHQR notification flow, and cashier KHQR confirmation flow on the stacked production-hardening branch.

## Confirmed protections

### Refund workflow

- The cashier refund endpoint requires the `can_refund` permission and a store-scoped order lookup.
- Refund writes execute inside a transaction and lock the order row with `SELECT ... FOR UPDATE`.
- The `refund_requests` table has a unique key on `(store_id, idempotency_key)`; the key is case-sensitive under the ASCII binary collation.
- The request hash binds the order, requested amount in cents, reason, note, and cashier identity. Reusing a key with a different payload is rejected.
- A completed request stores its response for replay. Replays do not repeat the order update, audit write, or Socket.IO notification.
- Partial refunds accumulate in integer cents; the route rejects corrupt historical refund amounts and amounts above the remaining balance.
- Order state and audit entry are written in the same transaction. Realtime notifications are emitted only after commit.

### KHQR cashier-confirmation workflow

- Waiter notification and cashier confirmation are distinct steps; a waiter notification does not mark an order paid.
- The waiter notification route locks the store-scoped order, verifies the QR generation ID, updates `awaiting_confirm` conditionally, and writes an audit entry in the same transaction.
- Repeated notification after a committed request is treated as an idempotent retry and does not emit a second notification.
- Cashier confirmation locks the table and order, checks the QR generation against the confirmation request, validates cash amounts in cents, conditionally changes the order from `pending` to `done`, and writes an audit entry before commit.
- The Socket.IO settlement events are emitted after the transaction completes.
- Existing tests cover duplicate waiter notification, stale/replaced QR generations, cross-store access, sub-cent amounts, and cashier confirmation.

## Important integration boundary

The inspected code implements a **staff-mediated payment confirmation** flow. The repository search and route review in this pass did not identify a dedicated external payment-provider webhook handler with provider signature verification and provider-event idempotency.

Therefore this review does not establish that an external bank/Bakong callback is authenticated, replay-protected, or reconciled. Do not connect an unverified provider callback directly to the order-settlement update. Before adding one, require:

1. Provider-specific signature or authenticated transport verification using the official provider contract.
2. Verification of merchant/account identity, amount, currency, order reference, and final payment status.
3. A durable unique provider-event identifier (or provider transaction ID) with a database uniqueness constraint.
4. A locked, store-scoped order transition and exact amount comparison in one transaction.
5. Duplicate, delayed, out-of-order, failed, and reversed event handling tests.
6. A reconciliation process against provider settlement reports.

## Ledger and reconciliation follow-up

The inspected refund path updates the aggregate `orders.refund_amount` and writes an audit record plus an idempotency response. This is useful for operational traceability, but it is not a substitute for a dedicated append-only financial ledger if the business needs multiple refund events, provider transaction references, fees, settlement batches, chargebacks, and accounting reconciliation.

A ledger migration should be designed separately with explicit accounting rules and a backfill/reconciliation plan. No ledger schema migration is included in this change.

## Validation limits

- CI verifies automated repository tests and static checks only.
- No live bank/payment-provider credentials or callback signature test was available.
- No real-money refund, production database, settlement reconciliation, or load test was performed.
- Production rollout still requires staging verification, backup, monitoring, and a rollback plan.
