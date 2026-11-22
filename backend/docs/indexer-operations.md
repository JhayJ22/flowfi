# Indexer Operations Guide

This document describes the externally observable behavior of the indexer's
lease coordination, the database indexes backing stream/event reads, the
admin replay preview/execute contract, the Soroban RPC retry/backoff policy,
graceful shutdown and poll cancellation, the ledger-consistent snapshot
endpoint, and the indexer metrics. It is written for operators and on-call
engineers. All public interfaces described here are additive; existing
endpoints and configuration keys keep working unless noted.

---

## 0. Field-level privacy and retention inventory

This inventory maps every wallet-linked field family the indexer touches to
its data store, purpose, retention rule, deletion constraint, and owner. It
exists so product and operations changes can be reviewed consistently against
the same privacy and retention expectations. Field families are grouped by the
store that holds them; each row links to the owning policy.

### Field families

| Field family | Data store | Purpose | Retention rule | Deletion constraint | Owner | Policy |
| --- | --- | --- | --- | --- | --- | --- |
| `wallet_address` (sender/recipient) | `streams`, `events` tables | Stream/event indexing and per-wallet history | Retained for the life of the indexed ledger record; no TTL | Cannot be deleted while the stream is referenced by an event; deletion requires a replay/reset of the affected ledger range | Indexer team | `SECURITY.md` (data handling) |
| `stream_id`, `event_id` | `streams`, `events` tables | Cursor advancement and replay targeting | Retained with the parent record | Deleted only via ledger-range replay/reset; never orphaned | Indexer team | `SECURITY.md` (data handling) |
| `cursor` / `fencing_token` | `indexer_cursor` table | Lease coordination and monotonic progress | Retained indefinitely (operational state) | Not user-deletable; reset only through the admin reset path | Indexer team | `SECURITY.md` (data handling) |
| Request/owner identifiers | Application logs | Debugging, lease and replay auditing | Rotated per log retention window; no wallet addresses in log lines | Log lines are append-only; redaction happens at write time | Platform/on-call | `SECURITY.md` (logging) |
| Aggregate event counts | Analytics store | Analytics by event type and ledger range | Aggregated only; no raw wallet addresses | Aggregates are not individually deletable; recomputed from source | Analytics owner | `SECURITY.md` (analytics) |
| Exported stream/event rows | Operator exports | Reconciliation and support | Export lifetime is operator-controlled; exports inherit source retention | Exports must be deleted when the source ledger range is reset | Operations | `SECURITY.md` (exports) |
| Webhook payloads (wallet-linked) | Webhook delivery logs | Delivery retry and audit | Retained for the webhook retry window, then purged | Cannot be edited; purged on window expiry or on source reset | Integrations owner | `SECURITY.md` (webhooks) |
| Database backups | Backup storage | Disaster recovery | Retained per the backup retention schedule | Backups are immutable; deletion follows the backup expiry schedule, not per-record requests | Platform/on-call | `SECURITY.md` (backups) |

### Review rules

- Every new wallet-linked field family **must** be added to this table with a
  store, purpose, retention rule, deletion constraint, owner, and policy link
  before it ships.
- A field family with a missing owner, policy, or retention rule is treated as
  a review failure and blocks the change.
- Unknown or empty field families are not silently dropped; they are recorded
  as `unclassified` and routed to the indexer team for triage.
- Retention and deletion constraints here must stay consistent with the
  wallet authorization and secret-handling requirements in `SECURITY.md`.

---

## 0.1 Partner onboarding and go-live checklist

This section gives an external integration team a verified path from zero to
production traffic. It covers credential configuration, webhook handling
validation, reconciliation testing, and production readiness. Every step is
runnable and every environment is kept strictly separate: **testnet and
production never share credentials, endpoints, or webhook secrets.**

### Environment separation

| Concern | Testnet | Production |
| --- | --- | --- |
| API base URL | `https://api.testnet.example.com` | `https://api.example.com` |
| Soroban RPC | `https://soroban-testnet.stellar.org` | Operator-provided mainnet RPC |
| Network passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| API credentials | Testnet-only key | Production key issued after go-live review |
| Webhook signing secret | Testnet-only secret | Production secret, rotated on schedule |

Rules:

- Never reuse a testnet key or webhook secret in production, and never point a
  production key at a testnet endpoint (or vice versa). The indexer rejects a
  request whose network passphrase does not match the configured network.
- Store credentials in the partner's secret manager, not in source control or
  shell history. Rotate the webhook secret on the schedule in `SECURITY.md`.

### Step 1 — Configure credentials (testnet)

```bash
# Testnet only. Do not reuse these values in production.
export PARTNER_API_BASE="https://api.testnet.example.com"
export PARTNER_API_KEY="$(secret-tool lookup service partner env testnet)"
export PARTNER_WEBHOOK_SECRET="$(secret-tool lookup service partner-webhook env testnet)"

# Verify the key is accepted and the network matches.
curl -fsS "$PARTNER_API_BASE/v1/health" \
  -H "Authorization: Bearer $PARTNER_API_KEY" | jq '{network, status}'
# Expected: {"network":"testnet","status":"ok"}
```

Failure cases to confirm before continuing:

- A missing or empty `PARTNER_API_KEY` returns `401`.
- A production key against the testnet base URL returns `403` (network
  mismatch), not a silent success.

### Step 2 — Validate webhook handling

Register a testnet webhook endpoint, then verify signature handling with a
runnable sample. The signature is computed over the raw request body with the
webhook secret; a tampered body or wrong secret must be rejected.

```bash
# Send a signed testnet webhook to your own handler.
BODY='{"event":"stream.created","stream_id":"test-1"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$PARTNER_WEBHOOK_SECRET" -hex | awk '{print $2}')

curl -fsS -X POST "https://partner.example.com/webhooks/indexer" \
  -H "Content-Type: application/json" \
  -H "X-Signature: sha256=$SIG" \
  --data "$BODY"
```

Your handler must:

- Recompute the HMAC over the **raw** body and compare in constant time.
- Return `2xx` only after the event is durably recorded (idempotent by
  `event_id`), so retries are safe.
- Reject a bad signature with `401` and a body that fails verification with
  `400`; never process an unverified payload.

Failure cases to confirm:

- A wrong `PARTNER_WEBHOOK_SECRET` yields `401` and no side effects.
- A body modified after signing yields `401`.
- A replayed `event_id` is acknowledged but not processed twice.

### Step 3 — Test reconciliation

Reconcile your records against the indexer's stream/event history for a known
ledger range, then confirm the cursor advanced monotonically.

```bash
# Pull events for a known testnet ledger range and compare counts.
curl -fsS "$PARTNER_API_BASE/v1/events?from_ledger=1000&to_ledger=1100" \
  -H "Authorization: Bearer $PARTNER_API_KEY" \
  | jq '{count: (.events | length), last_ledger: .cursor}'
```

- Totals must match your own ledger of record for the same range; a mismatch
  is a reconciliation failure and blocks go-live.
- Boundary cases: an empty range returns `count: 0` with an unchanged cursor;
  a range beyond the indexed head returns the indexed head, never a future
  ledger.

### Step 4 — Clean-environment validation (required before publication)

Before requesting production credentials, run the full flow above in a **fresh
environment** with no cached state, using only testnet credentials:

1. Provision a clean host/container with no prior config.
2. Set only the testnet variables from Step 1.
3. Run Steps 1–3 end to end and record the outputs.
4. Confirm no production secret or endpoint appears in the environment
   (`env | grep -i partner` must show testnet values only).

A go-live request is not accepted until this clean-environment run passes and
its outputs are attached to the request.

### Step 5 — Go-live checklist

- [ ] Clean-environment validation (Step 4) passed and outputs attached.
- [ ] Production credentials issued and stored in the secret manager.
- [ ] Production webhook secret set and rotation schedule recorded.
- [ ] Webhook handler verifies signatures and is idempotent by `event_id`.
- [ ] Reconciliation matches for a known production ledger range.
- [ ] Network passphrase and RPC endpoint confirmed as mainnet.
- [ ] No testnet key, secret, or endpoint present in production config.
- [ ] On-call contact and rollback plan documented.

---

## 0. Multi-network deployment decision guide

This section explains how operators select and verify the **network, contract,
token, endpoint, and release artifact** combination for each environment. It is
the first thing to read before deploying or promoting a release. The values
below are verified against the current deployment configuration
(`.github/workflows/deploy-contracts.yml`, the testnet e2e config, and the
backend env example); if those files change, update this guide in the same PR.

### 0.1 Environments and their fixed combinations

Each environment pins a single, consistent combination. Never mix values from
different rows.

| Environment | Network / passphrase | Contract source | Token | RPC / Horizon endpoint | Release artifact |
| --- | --- | --- | --- | --- | --- |
| `local` | `Standalone` (`Standalone Network ; February 2017`) | built from working tree | locally issued test token | `http://localhost:8000/soroban/rpc`, `http://localhost:8000` | none (source build) |
| `testnet` | `Test SDF Network ; September 2015` | deployed by `deploy-contracts.yml` | testnet token from deploy output | `https://soroban-testnet.stellar.org`, `https://horizon-testnet.stellar.org` | tagged release artifact |
| `mainnet` | `Public Global Stellar Network ; September 2015` | deployed by `deploy-contracts.yml` (protected env) | mainnet token from deploy output | `https://soroban-mainnet.stellar.org`, `https://horizon.stellar.org` | tagged release artifact |

Rules that follow from the table:

- **Network passphrase is authoritative.** The backend must be configured with
  the passphrase matching the RPC endpoint. A mismatch causes signature
  verification to fail; do not "fix" it by disabling validation.
- **Contract and token IDs are per-network.** A contract ID from testnet is
  meaningless on mainnet. Always take contract and token IDs from the deploy
  output of the *same* environment.
- **Endpoints are per-network.** RPC and Horizon must both point at the same
  network. Mixing a testnet RPC with a mainnet Horizon URL is a misconfiguration.
- **Release artifacts are immutable.** Promote the exact artifact that was
  built and tested for the target network; do not rebuild during promotion.

### 0.2 Preflight checklist

Run through this checklist before every deploy or promotion. Each item maps to
an automated check where one exists.

1. **Network passphrase** matches the target environment (see table).
2. **RPC endpoint** host matches the network (testnet vs mainnet host).
3. **Horizon endpoint** host matches the same network as the RPC endpoint.
4. **Contract ID** was produced by the deploy run for this environment and is
   present in the deploy output / env file.
5. **Token contract ID** comes from the same deploy output as the contract ID.
6. **Release artifact** is the tagged artifact built for this network; its
   checksum matches the published release.
7. **Secrets** (deployer key, admin key) are provided by the environment's
   secret store — never committed and never copied between environments.
8. **Backend env** has no leftover values from another environment (grep the
   env file for the other network's hostnames and passphrases).

### 0.3 Safe failure examples

These are the expected, safe outcomes when a combination is wrong. In every
case the system must **fail closed** — refuse to start or refuse the operation
— rather than silently proceeding.

- **Passphrase / endpoint mismatch.** Backend configured with the testnet
  passphrase but a mainnet RPC URL: startup validation rejects the config and
  the process exits non-zero. It does not fall back to a default network.
- **Cross-network contract ID.** A testnet contract ID supplied on mainnet:
  contract calls fail with a not-found / invalid-contract error; the indexer
  does not advance the cursor past the failed ledger.
- **Token from the wrong network.** A token ID that does not exist on the
  configured network: token reads fail explicitly; balances are not reported
  as zero.
- **Stale release artifact.** An artifact whose checksum does not match the
  published release for the target network: promotion is blocked before
  deploy.
- **Leaked cross-environment secret.** A deployer key from another environment:
  the deploy transaction is rejected by the network (wrong account / wrong
  network); the deploy job fails and does not retry with a different key.

If any of these occur, stop, correct the configuration, and re-run the
preflight checklist. Do not weaken network or chain validation to make a
deploy pass.

---

## 0.4 API version migration guides

This section publishes a migration guide for each supported API version. Each
guide links to the OpenAPI schema that defines the version's contract, lists
the explicit behavior differences from the previous version, gives the
deprecation timeline, and includes a compatibility checklist plus tested
request/response examples. Integrators should read the guide for the version
they are moving **to** before changing client code.

Supported versions and their schemas:

| API version | OpenAPI schema | Status | Deprecation date | Sunset date |
| --- | --- | --- | --- | --- |
| `v1` | [`openapi/v1.yaml`](../openapi/v1.yaml) | deprecated | 2025-06-30 | 2025-12-31 |
| `v2` | [`openapi/v2.yaml`](../openapi/v2.yaml) | current | — | — |

If a schema file is not present in your checkout, the version is not yet
published; do not integrate against an unpublished version.

### 0.4.1 Migrating `v1` → `v2`

**Schema:** [`openapi/v2.yaml`](../openapi/v2.yaml) (previous:
[`openapi/v1.yaml`](../openapi/v1.yaml)).

**Timeline.** `v1` is deprecated as of **2025-06-30** and will be sunset on
**2025-12-31**. After the sunset date, `v1` requests return `410 Gone`. During
the deprecation window both versions are served; `v1` responses include a
`Deprecation` header and a `Sunset` header carrying the dates above.

**Behavior differences.**

| Area | `v1` | `v2` |
| --- | --- | --- |
| Pagination | offset (`page`, `limit`) | cursor (`cursor`, `limit`); `next_cursor` in body |
| Timestamps | epoch seconds (integer) | RFC 3339 strings (UTC) |
| Amounts | decimal strings, unvalidated | decimal strings, validated against token decimals |
| Errors | `{ "error": "..." }` | `{ "error": { "code", "message", "details" } }` |
| Unknown query params | ignored | rejected with `400 invalid_request` |
| Missing resource | `200` with empty body | `404 not_found` |

**Compatibility checklist.**

- [ ] Client sends `Accept: application/vnd.api.v2+json` (or the `v2` path
      prefix) on every request.
- [ ] Pagination switched from `page`/`limit` to `cursor`/`limit`; client
      follows `next_cursor` until it is absent.
- [ ] Timestamp parsing handles RFC 3339 strings, not epoch integers.
- [ ] Error handling reads `error.code` / `error.message` instead of a flat
      string.
- [ ] Client tolerates `404` for missing resources (no longer `200` empty).
- [ ] Client stops sending query params the endpoint does not define.
- [ ] Amount handling validates against token decimals before display.
- [ ] Integration tests run against both `v1` and `v2` until `v1` sunset.

**Tested examples.**

`v1` request (deprecated):

```http
GET /api/v1/streams?page=1&limit=2 HTTP/1.1
Accept: application/vnd.api.v1+json
```

`v1` response (`200`):

```json
{
  "items": [
    { "id": "stream_1", "created_at": 1719792000, "amount": "10.5" }
  ],
  "page": 1,
  "limit": 2
}
```

`v2` request (current):

```http
GET /api/v2/streams?limit=2 HTTP/1.1
Accept: application/vnd.api.v2+json
```

`v2` response (`200`):

```json
{
  "items": [
    { "id": "stream_1", "created_at": "2024-07-01T00:00:00Z", "amount": "10.5" }
  ],
  "next_cursor": "c3RyZWFtXzE"
}
```

`v2` failure case — unknown query param (`400`):

```json
{ "error": { "code": "invalid_request", "message": "unknown query parameter: page" } }
```

`v2` boundary case — missing resource (`404`):

```json
{ "error": { "code": "not_found", "message": "stream not found" } }
```

These examples are exercised by the API contract tests; if a response shape
changes, update the schema, the tests, and this guide in the same PR.

---

## 0. Operator CLI: deployment validation and read-only inspection

The FlowFi operator CLI lets contributors and operators validate deployment
configuration and inspect public contract and indexer metadata **without
secret-bearing defaults**. It never ships with credentials baked in and never
prints secret values.

### Commands

| Command | Writes? | Purpose |
| --- | --- | --- |
| `flowfi-cli config validate` | No | Validate deployment configuration (required keys, network, contract IDs) |
| `flowfi-cli contract inspect` | No | Print public contract metadata (address, network, version) |
| `flowfi-cli indexer inspect` | No | Print public indexer metadata (cursor, lease owner, health) |
| `flowfi-cli deploy` | **Yes** | Deploy/upgrade contracts; requires explicit confirmation |

### Secret handling

- **No secret-bearing defaults.** The CLI reads secrets only from the
  environment or an explicit `--config` file supplied by the operator. There
  are no hardcoded keys, tokens, or credentials.
- **Redaction.** Any value whose key matches a secret pattern (e.g.
  `*_SECRET`, `*_KEY`, `*_TOKEN`, `*_PASSWORD`, `DATABASE_URL`) is redacted in
  all output as `***`. Redaction applies to `config validate`, inspection
  commands, and error messages.
- **Read-only by default.** Inspection and validation commands perform no
  writes and are safe to run against production.

### Explicit confirmation for writes

Write commands (`deploy`) require explicit confirmation before mutating
state:

- Interactive runs prompt for confirmation and abort on anything other than
  an explicit `yes`.
- Non-interactive runs must pass `--yes`; without it the command exits
  non-zero without writing.

### Execution paths

- **Offline.** `config validate` and inspection commands run fully offline
  against local config; they do not require network access.
- **Wrong network.** If the configured network does not match the target
  contract's network, validation fails with a clear error and no writes occur.
- **Read-only.** Inspection commands never write and never require write
  credentials.

### Failure and boundary cases

- Missing required configuration keys fail validation with a non-zero exit
  code and a redacted report.
- A network mismatch fails validation before any write command proceeds.
- A write command without confirmation exits non-zero and performs no writes.

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
  the lease is rejected by the same fencing check that guards cursor writes.

---

## 4. Ledger-consistent multi-resource snapshots

### Contract

The snapshot endpoint returns related **stream**, **event**, and **balance**
data tied to a single indexed ledger checkpoint, so clients never have to
stitch together results read at different ledger heights.

- **Single checkpoint.** All resources in a response are read at the same
  indexed ledger. The response echoes that ledger as `ledger`.
- **Staleness metadata.** The response includes `indexerLag` (current chain
  head minus the snapshot ledger) and `stale` (whether the snapshot is older
  than the configured freshness threshold).
- **No checkpoint yet.** If the indexer has not yet indexed any ledger, the
  endpoint returns a `409`-style "no checkpoint" result rather than an empty
  snapshot; clients should retry after the indexer catches up.

### Response fields

| Field | Description |
| --- | --- |
| `ledger` | The indexed ledger checkpoint the snapshot was read at |
| `indexerLag` | Ledgers between the chain head and `ledger` (0 when caught up) |
| `stale` | `true` when `indexerLag` exceeds the freshness threshold |
| `streams` | Stream records as of `ledger` |
| `events` | Event records as of `ledger` |
| `balances` | Balance records as of `ledger` |

### Client retry semantics

When the indexer is lagging, clients **must retry** rather than combine
results from different ledgers:

- If `stale` is `true`, treat the snapshot as advisory and retry with backoff
  until a fresher snapshot is available; do **not** merge it with data from
  another request.
- If the endpoint reports no checkpoint yet, retry after a short delay.
- A snapshot is internally consistent by construction; combining resources
  across two snapshot responses read at different `ledger` values is not
  supported and can produce inconsistent views.

### Boundary cases

- **Zero lag:** `indexerLag` is `0` and `stale` is `false` when the indexer is
  caught up to the chain head.
- **Large lag:** `indexerLag` grows with the gap; `stale` flips to `true` once
  the threshold is exceeded.
- **No checkpoint:** the endpoint signals retry instead of returning partial
  data.

---

## 5. Soroban RPC retry and backoff

### Behavior

Soroban RPC calls are retried with bounded exponential backoff and jitter.

- **Retryable errors.** Transient transport failures, timeouts, and rate-limit
  responses are retried. Deterministic errors (invalid arguments, not found)
  are not retried.
- **Bounded attempts.** Each call has a maximum attempt count and a cap on the
  backoff delay; jitter avoids synchronized retry storms across replicas.
- **Cursor safety.** A failed poll does not advance the cursor; the next poll
  resumes from the last successfully applied ledger.

### Configuration

| Key | Meaning | Notes |
| --- | --- | --- |
| `SOROBAN_RPC_MAX_ATTEMPTS` | Maximum attempts per call | Includes the first attempt |
| `SOROBAN_RPC_BASE_BACKOFF_MS` | Base backoff delay | Grows exponentially per attempt |
| `SOROBAN_RPC_MAX_BACKOFF_MS` | Backoff cap | Upper bound after jitter |

---

## 6. Graceful shutdown and poll cancellation

### Behavior

On shutdown the indexer stops accepting new work, cancels any in-flight poll,
and releases the lease so another replica can take over promptly.

- **Cancellation.** An in-flight poll observes the shutdown signal and aborts
  before advancing the cursor; partially applied work is not committed.
- **Lease release.** The lease is released on shutdown so takeover latency is
  not bounded by the TTL.
- **Idempotent restart.** Because the cursor only advances on committed work,
  a restart resumes from the last applied ledger without duplication.

---

## 7. Metrics

| Metric | Meaning |
| --- | --- |
| `indexer_lease_acquired_total` | Successful lease acquisitions |
| `indexer_lease_renewed_total` | Successful lease renewals |
| `indexer_lease_lost_total` | Lease losses (expiry or renewal failure) |
| `indexer_fenced_write_rejected_total` | Cursor writes rejected by fencing |
| `indexer_poll_duration_ms` | Poll duration histogram |
| `indexer_cursor_ledger` | Current indexed ledger |
| `indexer_lag_ledgers` | Chain head minus indexed ledger |
| `indexer_snapshot_stale_total` | Snapshots served while stale |
