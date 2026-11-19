# Indexer Operations Guide

This document describes the externally observable behavior of the indexer's
lease coordination, the database indexes backing stream/event reads, the
admin replay preview/execute contract, the Soroban RPC retry/backoff policy,
graceful shutdown and poll cancellation, the maintenance mode controls, and
the indexer metrics. It is written for operators and on-call engineers. All
public interfaces described here are additive; existing endpoints and
configuration keys keep working unless noted.

---

## 1. Poll ownership lease

### Behavior

The indexer uses a single renewable lease stored in the database to guarantee
that **at most one backend replica actively polls and advances the cursor** at
any time.

- **Single owner.** A worker acquires the lease before polling. Only the
  current lease owner may advance the indexer cursor. Non-owners idle and
  periodically attempt acquisition.
- **Owner identity.** Each worker has a unique owner ID (hostname + process
  identity + random suffix). The lease records the current owner ID and a
  monotonically increasing **fencing token** (generation number).
- **TTL and renewal.** The lease has a finite TTL. The owner renews it on a
  heartbeat well before expiry. If renewal fails (e.g., DB unavailable), the
  worker stops advancing the cursor and releases ownership locally.
- **Takeover.** If the lease expires without renewal (owner crash, network
  partition, or shutdown), another worker may acquire it. Acquisition
  increments the fencing token.
- **Fencing.** Every cursor write is conditional on the writer still holding
  the lease at the current fencing token. A stale owner whose lease has been
  taken over will have its writes **rejected** rather than overwriting the new
  owner's progress. Rejected writes are logged and counted (see metrics).

### Externally observable effects

- At most one replica advances the cursor at a time; the cursor is monotonic
  per fencing generation.
- After an owner is lost, another replica takes over within roughly one TTL
  plus the acquisition retry interval.
- Stale writes from a former owner are discarded; they never move the cursor
  backwards or skip ledgers.

### Configuration

| Key | Meaning | Notes |
| --- | --- | --- |
| `INDEXER_LEASE_TTL_MS` | Lease time-to-live | Defaults are safe; must exceed renewal interval |
| `INDEXER_LEASE_RENEW_INTERVAL_MS` | Renewal heartbeat interval | Must be well below TTL |
| `INDEXER_LEASE_ACQUIRE_RETRY_MS` | Retry interval for non-owners | Controls takeover latency |

### Rollout and migration

- The lease table is created by migration and is additive; no existing data is
  rewritten.
- **Rolling upgrade:** during a mixed-version rollout, older replicas that do
  not participate in the lease must not run concurrently with new replicas
  against the same cursor. Recommended sequence:
  1. Apply the migration.
  2. Scale the indexer to a single replica (or stop old replicas).
  3. Deploy the lease-aware version.
  4. Scale back up; the lease ensures a single active owner.
- **Rollback:** the lease table may remain in place; older versions ignore it.
  Ensure only one replica runs if rolling back to a non-lease version.

---

## 2. Database indexes for stream and event reads

### Added indexes

The following indexes were added after profiling representative PostgreSQL
query plans for list, history, analytics, and cursor queries. Each is
migration-safe (created with `CREATE INDEX`; no data rewrite) and preserves
result ordering and pagination semantics.

| Index | Table | Columns | Hot path served |
| --- | --- | --- | --- |
| `streams_created_at_id_idx` | `streams` | `(created_at DESC, id DESC)` | Stream list ordering + keyset pagination |
| `streams_sender_idx` | `streams` | `(sender, created_at DESC)` | Per-wallet stream history |
| `events_stream_id_ledger_idx` | `events` | `(stream_id, ledger DESC)` | Per-stream event history |
| `events_ledger_idx` | `events` | `(ledger)` | Cursor scan / ledger range reads |
| `events_type_ledger_idx` | `events` | `(type, ledger DESC)` | Analytics by event type |

### Query-plan evidence

Before/after `EXPLAIN (ANALYZE, BUFFERS)` was captured for each hot path on a
representative dataset. Summary:

- **Stream list (keyset pagination):** before — sequential scan + sort;
  after — index scan on `streams_created_at_id_idx`, no sort node, stable
  ordering by `(created_at, id)`.
- **Per-wallet history:** before — filter + sort over `streams`; after —
  index scan on `streams_sender_idx`.
- **Per-stream events:** before — filter on `stream_id` then sort; after —
  index scan on `events_stream_id_ledger_idx`.
- **Cursor scan / ledger range:** before — sequential scan; after — index
  scan on `events_ledger_idx`.
- **Analytics by type:** before — filter + sort; after — index scan on
  `events_type_ledger_idx`.

### Operational impact

- Index creation takes a brief lock; on large tables run during a low-traffic
  window or use the provided migration which creates indexes without blocking
  writes where supported.
- Additional write amplification on `events` and `streams` inserts is modest
  and was measured within acceptable bounds.
- No public query interfaces changed; ordering and pagination are preserved.

---

## 3. Admin replay: preview and execution

### Contract

Replay is exposed under the existing admin replay controls. Two operations:

- **Preview** (`preview`): computes the affected ledger range and the expected
  record changes **without performing any writes**. Safe to call repeatedly.
- **Execute** (`execute`): performs the replay and returns an execution report.
  Supports retry.

Both accept the same replay parameters as before (ledger range / target). The
response is a **report** with the following fields:

| Field | Description |
| --- | --- |
| `requestId` | Correlation ID for this preview/execute call |
| `mode` | `preview` or `execute` |
| `ledgerRange.from` / `ledgerRange.to` | Affected ledger range (inclusive) |
| `expectedChanges` | Preview only: counts of records that would be created/updated/deleted |
| `counts` | Execute only: records created/updated/deleted/skipped |
| `durationMs` | Wall-clock duration of the operation |
| `status` | `succeeded` / `failed` / `partial` |
| `failurePosition` | On failure: the ledger at which execution stopped (null on success) |
| `liveCursor` | The live indexer cursor after the operation |

### Guarantees

- **Preview performs no writes.** It is read-only and reproducible.
- **Execution reports are reproducible** for the same inputs and starting
  state; retries produce a fresh `requestId` and report.
- **Live cursor is preserved on failure.** If execution fails partway, the
  live cursor is not advanced past the last successfully applied ledger, and
  `failurePosition` identifies where it stopped. Retry resumes from there.

### Concurrency: replay vs. live polling

Replay, reset, and normal polling all mutate the same shared cursor and event
state, so they are **serialized** against each other. The serialization is
enforced at the database layer (a transaction-scoped advisory lock keyed on the
indexer cursor row), not in process memory, so it holds **across multiple
backend instances**.

- **Mutual exclusion.** While a replay (or reset) holds the lock, the live
  worker cannot advance the cursor; while the live worker holds it, replay
  waits. Operations queue rather than interleave.
- **Monotonic cursor.** The cursor never moves backwards as a result of a
  replay overlapping a poll. A replay that would move the cursor behind the
  live position is rejected (reported as `status: failed` with a clear
  message) instead of silently rewinding it.
- **Deterministic event state.** Because replay and polling never run
  concurrently, the resulting event state for a given starting state and
  inputs is deterministic regardless of which replica handled the poll or the
  replay.
- **Fencing still applies.** A replay executed by a replica that does not hold
  the lease is rejected; replay does not bypass lease fencing.

---

## 4. Maintenance mode

Maintenance mode lets operators **pause user-facing mutations** during planned
maintenance while keeping the service observable and recoverable. It is
intended for short, planned windows; it is not a substitute for draining or
scaling down the indexer.

### Endpoints

All maintenance endpoints live under the operator/admin surface and require
operator authorization (the same admin credential used for replay). Requests
without valid operator authorization are rejected with `401`/`403` and never
change state.

| Method & path | Purpose |
| --- | --- |
| `POST /admin/maintenance/enter` | Enter maintenance mode (pause user mutations) |
| `POST /admin/maintenance/exit` | Exit maintenance mode (resume user mutations) |
| `GET /admin/maintenance/status` | Read current maintenance state |

`enter` and `exit` accept an optional `reason` string that is recorded for
operator visibility. `status` is read-only and safe to poll.

### Status response

| Field | Description |
| --- | --- |
| `active` | `true` while maintenance mode is engaged |
| `since` | Timestamp maintenance mode was entered (null when inactive) |
| `reason` | Operator-supplied reason (null when none) |
| `mutationsPaused` | `true` when user mutations are currently rejected |

### Behavior while active

- **User mutations are rejected** with `503 Service Unavailable` and a
  machine-readable `maintenance` error code. This applies to write endpoints
  (stream creation, cancellation, and other state-changing user operations).
- **Read-only endpoints keep working.** Status, list, history, and analytics
  reads continue to serve normally so operators and clients retain recovery
  visibility.
- **Wallet authorization and chain/network validation are unchanged.**
  Maintenance mode does not relax any authorization, validation, or accounting
  invariant; it only gates whether mutations are accepted.
- **The indexer keeps its lease and cursor.** Maintenance mode does not stop
  polling or release the lease; it only gates user mutations.

### Health and readiness

- **Liveness** (`/health/live`) continues to report healthy while maintenance
  mode is active — the process is up and serving.
- **Readiness** (`/health/ready`) reports **not ready** while maintenance mode
  is active, so load balancers and orchestrators stop routing new traffic to
  the instance instead of reporting false readiness. Readiness returns to
  healthy once maintenance mode is exited.

### Transition races

Enter and exit are **idempotent** and safe under concurrent calls:

- Repeated `enter` while already active is a no-op that returns the current
  status (it does not reset `since`).
- Repeated `exit` while already inactive is a no-op that returns the current
  status.
- Concurrent `enter`/`exit` calls are serialized so the final state matches
  the last committed transition; callers always receive the resulting status.

### Recovery

To resume normal operation, call `POST /admin/maintenance/exit`. Confirm via
`GET /admin/maintenance/status` that `active` is `false` and
`mutationsPaused` is `false`, and that `/health/ready` reports healthy before
restoring traffic.

---

## 5. Soroban RPC retry and backoff

### Policy

Soroban RPC calls are retried on transient failures (timeouts, connection
resets, `429`, and `5xx`) with **exponential backoff and jitter**. Non-retryable
failures (e.g., malformed requests, `4xx` other than `429`) fail fast.

- **Bounded attempts.** Each call has a maximum attempt count; after it is
  exhausted the call fails and the error is surfaced.
- **Exponential backoff with jitter.** Delay grows exponentially per attempt up
  to a cap, with randomized jitter to avoid synchronized retry storms across
  replicas.
- **Idempotent reads.** Read calls are safe to retry. Writes are only retried
  when the operation is idempotent by construction.

### Configuration

| Key | Meaning | Notes |
| --- | --- | --- |
| `SOROBAN_RPC_MAX_ATTEMPTS` | Maximum attempts per call | Includes the first attempt |
| `SOROBAN_RPC_BASE_DELAY_MS` | Initial backoff delay | Grows exponentially |
| `SOROBAN_RPC_MAX_DELAY_MS` | Backoff cap | Upper bound per attempt |

### Observability

Retries and exhausted attempts are logged with the call name and attempt
number, and counted in metrics (see below).

---

## 6. Graceful shutdown and poll cancellation

### Behavior

On `SIGTERM`/`SIGINT` the indexer begins a graceful shutdown:

- **Stop accepting new work.** New polls are not started.
- **Cancel in-flight polls.** The active poll is cancelled via its context;
  partial progress is not committed past the last successfully applied
  ledger.
- **Release the lease.** The lease is released so another replica can take
  over promptly rather than waiting for TTL expiry.
- **Bounded drain.** Shutdown waits up to a configured grace period for
  in-flight work to finish, then exits.

### Configuration

| Key | Meaning | Notes |
| --- | --- | --- |
| `INDEXER_SHUTDOWN_GRACE_MS` | Max time to drain on shutdown | Keep below orchestrator kill timeout |

---

## 7. Metrics

| Metric | Type | Description |
| --- | --- | --- |
| `indexer_lease_acquired_total` | counter | Lease acquisitions |
| `indexer_lease_renewed_total` | counter | Successful renewals |
| `indexer_lease_lost_total` | counter | Lease losses (expiry/takeover) |
| `indexer_cursor_write_rejected_total` | counter | Fenced cursor writes rejected |
| `indexer_poll_duration_ms` | histogram | Poll duration |
| `indexer_rpc_retry_total` | counter | Soroban RPC retries |
| `indexer_rpc_failure_total` | counter | Soroban RPC calls that exhausted retries |
| `indexer_maintenance_active` | gauge | `1` while maintenance mode is active, `0` otherwise |
| `indexer_maintenance_transitions_total` | counter | Enter/exit transitions applied |
