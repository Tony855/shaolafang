# Payment provider verification adapters

## Scope

This batch adds two deliberately limited server-side components:

- ABA PayWay payment callback signature verification.
- Bakong Open API read-only transaction status checks for dynamic KHQR digests.

Neither component confirms an order, writes a provider event, posts a journal entry, changes a refund, or performs a live request during startup. The existing staff-mediated KHQR confirmation path remains unchanged.

## ABA PayWay callback authentication

The adapter verifies the X-PAYWAY-HMAC-SHA512 request header using HMAC-SHA512 and Base64. It follows the official PayWay payment callback example: sort top-level JSON field names, concatenate scalar values in that order, calculate HMAC-SHA512 with the callback secret, then compare signatures in constant time.

Configuration is injected by the caller as secretKey; do not store the secret in source control, browser code, callback payloads, or logs. The verifier returns only the provider code, authentication result, transaction reference, approval code, status code, and SHA-256 digest of the request body. It does not retain raw callback bytes or payer personal data.

A valid signature proves callback authenticity only. Before any event may be accepted for settlement, the future integration must additionally:
1. Resolve the callback endpoint to the correct merchant/outlet configuration and verify account ownership.
2. Verify the provider transaction status using the server-to-server PayWay transaction API.
3. Match the exact order reference, amount, and currency against a locked store-scoped order.
4. Enforce provider transaction uniqueness and callback replay/idempotency.
5. Apply the approved order and ledger transition in one database transaction.

The official PayWay documentation describes transaction status lookup, transaction detail lookup, and transaction-list lookup. The transaction-list API is restricted to one outlet and a maximum three-day date range; this is not a general all-outlet bank statement feed. Request signing for outbound PayWay APIs must follow the exact ordered fields and merchant credentials supplied for the merchant profile. This adapter intentionally does not guess that request-hash construction.

## Bakong Open API

createBakongOpenApiClient() accepts an explicit HTTPS baseUrl, bearer token, and optional injected fetchImpl. It supports:
- checkTransactionByMd5(md5) for one dynamic KHQR payload digest.
- checkTransactionByMd5List(md5[]) for batches of 1–50 digests.

The batch response is correlated by digest, not response array position. Supported result states are SUCCESS, NOT_FOUND, STATIC_QR, and FAILED. Successful responses are validated for transaction hash, sender and receiver account IDs, currency, amount, and creation timestamp. The original amount is retained as text; no decimal-place or exchange-rate policy is inferred.

Bakong's documented MD5 check is for dynamic KHQR. The API reports that static QR status is unsupported. This API verifies a known QR payment; it is not a bank statement export or an unrestricted transaction-history feed. The caller must compare the returned receiver account, currency, amount, and transaction reference with its own expected payment context. A NOT_FOUND response is not proof of payment.

Set the base URL explicitly from the official environment details supplied to the integrator. Do not guess between SIT/production hosts or silently fall back to production. Keep the bearer token in a secret manager or protected environment variable.

## Tests and activation gate

tests/payment-provider-adapters.test.js uses deterministic mocked HTTP responses and test-only keys. No live provider credentials are present in CI. Before production activation, obtain sandbox credentials and verify the exact merchant/outlet account, callback delivery, transaction lookup, amount/currency semantics, rate limits, and failure/replay behavior in the provider sandbox.

This adapter-only batch does not expose an HTTP callback route, does not invoke recordVerifiedProviderEvent(), and does not transition any order or journal state.
