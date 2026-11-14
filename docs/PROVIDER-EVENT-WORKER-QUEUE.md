# Provider event worker queue

## Queue lifecycle

Verified provider events may be claimed by a worker only when a canonical normalized event is stored. The worker claims one eligible row inside a database transaction using `SELECT ... FOR UPDATE`, assigns a cryptographically random 256-bit lease token, increments the attempt count, and sets a lease expiry.

A crashed worker does not permanently strand an event: after lease expiry, another worker may reclaim it. Completion and failure updates require both the current lease token and an unexpired lease. Expiry itself fences the worker: even if no replacement worker has reclaimed the row yet, a late worker cannot complete or reschedule it after its lease deadline. The expiry predicate is checked again on the final state update after the locked read, so a lease that expires during failure handling is also rejected. A worker that performs business side effects and acknowledges within one outer transaction must let a stale-lease error roll back that entire transaction. This prevents work that exceeded its ownership window from committing side effects before the queue has formally reassigned the event.

## Retry and terminal failure

- Failed work returns to `received` with a delayed next-attempt timestamp until the configured attempt limit is reached.
- At the attempt limit, the event becomes `failed` for operator review / dead-letter handling.
- Error codes are stored as short sanitized identifiers, not arbitrary exception messages or provider payloads.
- The queue exposes a bounded retry delay; the worker policy should use exponential backoff with jitter when scheduling retries.

## Canonical event contract

The provider adapter must authenticate the exact raw callback bytes first, then map provider-specific data into a minimal canonical event object. Do not persist secrets, signatures, authorization headers, card/bank credentials, or unbounded raw callback bodies in `normalized_event_json`. The provider-specific adapter must still validate merchant identity, order reference, amount, currency, and final provider status before returning a verified event.

## Processing boundary

This queue is an infrastructure primitive. It does not change order state or create journal entries by itself. A future provider-specific processor must atomically lock and validate the target order, apply a permitted state transition, post the balanced journal entry, and mark the inbox event processed. If any step fails, the whole business transaction must roll back and the queue must be retried using the current lease.

## Queue indexes and deployment note

Startup performs additive, idempotent column and index migrations for installations that already created the original inbox table:

- `idx_provider_event_claim_received` supports the verified/received due-work path ordered by `next_attempt_at`, `received_at`, and `id`.
- `idx_provider_event_claim_lease` supports expired-lease recovery and final-attempt lease cleanup.

The migration validates existing index definitions and fails closed rather than silently accepting a same-name index with a different column order. The indexes are intended to reduce queue scans; actual optimizer selection and write overhead still require EXPLAIN and representative-volume measurements on the target MySQL/MariaDB versions.

**Important implementation boundary:** the repository currently contains the inbox persistence helper and queue primitive, but does not yet wire a public provider callback route or a continuously running provider-event worker into the application lifecycle. These helpers are not an active payment-processing path. Do not advertise webhook settlement as operational or enable live provider callbacks until the provider-specific intake, worker, order transition, journal posting, and staging acceptance gates are implemented.

Roll out schema changes to staging first, inspect query plans and lease behavior under multiple workers, and validate backup/restore after the new columns and indexes are present.
