# Financial reconciliation match suggestions

## Scope

This phase adds a deterministic, provider-neutral matching suggestion function. It does not import statements, query the database, persist a decision, mutate a reconciliation row, change an order, or post a journal transaction.

The caller supplies statement rows and a tenant-scoped candidate list built from existing financial journal transactions. Each candidate must contain its journal transaction ID, merchant/store IDs, source ID, integer minor-unit amount, and ISO currency code.

## Matching rules

A suggestion requires all of the following:

1. Exact reference equality: statement `transactionReference` or `externalReference` equals journal `sourceId`.
2. Exact merchant and store scope.
3. Exact integer minor-unit amount.
4. Exact three-letter currency code.
5. Exactly one qualifying journal transaction.

No fuzzy text matching, amount tolerance, exchange-rate conversion, date-window inference, or direction inference is performed. Bank debit/credit direction is intentionally not compared with journal debit/credit because the correct cash-account mapping depends on provider semantics and the approved chart of accounts.

## Result states

- `suggested`: exactly one candidate satisfies every exact rule. This is a recommendation only, not a confirmed match.
- `ambiguous`: multiple candidates satisfy every exact rule; an operator must resolve the ambiguity.
- `unmatched`: no tenant-scoped exact reference candidate exists.
- `exception`: an exact reference exists but amount or currency differs.

The helper is non-mutating and returns candidate IDs only. It never writes `matched_journal_transaction_id` or changes `match_status`. A future review workflow must authenticate an authorized finance operator, lock the reconciliation item and journal transaction, enforce tenant scope and one-to-one allocation, persist an immutable decision audit, and keep approval separate from automated suggestion.

## Security and accounting boundary

Candidate retrieval must be scoped by authenticated merchant/store context before invoking the helper. The helper also checks scope defensively. Do not pass untrusted request-supplied journal candidates directly.

Provider-specific statement parsing, callback verification, cash-account mapping, settlement fees, FX handling, chargebacks, and automated journal posting remain out of scope until official provider documentation and finance-approved accounting rules are available.
