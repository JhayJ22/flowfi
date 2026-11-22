# Backend Architecture

This document is the canonical reference for backend service architecture. It is
referenced by `backend/src/services/indexerService.ts` and
`backend/src/services/soroban-indexer.service.ts` as the authoritative source for
indexer ownership, SSE broadcast flow, and keeper-key authorization.

For the full project-wide architecture (event type data flows, pause/resume
timing, environment variables, and operational runbook) see
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

For the field-level privacy and retention inventory (wallet-linked fields across
logs, analytics, exports, webhooks, and backups) see
[Field-Level Privacy & Retention Inventory](#field-level-privacy--retention-inventory)
below.

---

## Architecture Decision Records

Decision records capture the data ownership, authorization, idempotency, and
on-chain/off-chain trade-offs that must be settled before introducing shared
accounts (organizations) or recurring schedules. Each record compares viable
alternatives, states the chosen option, and documents migration consequences.

### ADR-001: Organization (Shared Account) Model

**Status:** Proposed — requires review from contract and backend owners before
implementation begins.

**Context.** Users need to share streams and balances across a team. The
question is where organization membership and ownership live.

**Alternatives considered.**

| Option | Pros | Cons |
|--------|------|------|
| A. On-chain org registry (contract stores org → member mapping) | Membership is trustless and verifiable by any client; authorization enforced by the contract. | Every membership change is a transaction; higher gas and latency; contract upgrade required; wallet auth must still gate writes. |
| B. Off-chain ownership table (backend `Organization` / `OrganizationMember` Prisma models) | Cheap, fast membership edits; no contract change; reuses existing wallet auth. | Backend becomes the authorization source of truth for shared resources; on-chain state cannot enforce org permissions; requires careful audit logging. |
| C. Hybrid: off-chain membership, on-chain owner-of-record | Fast membership UX while the contract still sees a single owner address. | Two sources of truth for "who owns this stream"; reconciliation and revocation semantics are complex. |

**Decision.** Adopt **Option B (off-chain ownership table)** for the initial
release. Organization membership is stored in Prisma (`Organization`,
`OrganizationMember` with a `role` enum) and enforced by the backend API. The
contract continues to see a single owner address per stream; the backend maps
that owner to the organization. This keeps existing contract interfaces
compatible and avoids a contract upgrade.

**Data ownership.**

- **On-chain (source of truth):** stream balances, deposited/withdrawn amounts,
  and the stream owner address. These are never derived from org tables.
- **Off-chain (source of truth):** organization identity, membership, and roles.
  The backend is authoritative for org authorization only.
- **Mapping:** `Stream.ownerAddress` (on-chain) is linked to an
  `OrganizationMember.walletAddress`; an org-scoped stream is one whose owner
  address belongs to a member with the required role.

**Authorization.** Wallet-based auth is unchanged: every request must present a
signature from a wallet that is a member of the organization. Org roles
(`OWNER`, `ADMIN`, `MEMBER`) gate org-scoped actions, but the wallet signature
remains the primary credential. Chain/network validation is unchanged — the
backend still verifies the transaction targets the configured network before
acting. Org roles never bypass wallet authorization.

**Migration consequences.** Adding org tables is additive (new migrations, no
changes to existing `Stream` rows). Existing streams remain owned by their
wallet address and are treated as personal until explicitly attached to an org.
No contract migration is required. If a future ADR moves membership on-chain,
the off-chain table becomes a cache and must be reconciled against the registry.

### ADR-002: Recurring-Payment / Schedule Model

**Status:** Proposed — requires review from contract and backend owners before
implementation begins.

**Context.** Users want recurring payments (e.g. salaries) instead of one-off
streams. The question is where the schedule and its execution authority live.

**Alternatives considered.**

| Option | Pros | Cons |
|--------|------|------|
| A. On-chain scheduler (contract holds schedule and releases funds per period) | Trustless execution; no backend liveness dependency; funds custody is on-chain. | Contract complexity and upgrade cost; every period is a transaction; harder to change cadence. |
| B. Backend cron/keeper (backend triggers periodic stream creation or top-ups) | Reuses existing keeper-key flow and indexer; fast to ship; flexible cadence. | Backend liveness required; execution authority is a server key; must be idempotent to avoid double payments. |
| C. Hybrid: on-chain stream, backend-scheduled top-ups | Leverages existing stream contract; backend only schedules funding. | Still depends on backend liveness for funding; partial on-chain guarantees. |

**Decision.** Adopt **Option B (backend cron/keeper)** for the initial release,
building on the existing `KEEPER_SECRET_KEY` server-signed flow. A `Schedule`
Prisma model stores cadence, amount, and next-run time; a worker creates the
next stream/top-up when due. This reuses the existing keeper authorization and
indexer without a contract change.

**Data ownership.**

- **On-chain (source of truth):** each resulting stream's balances and the
  confirmed transactions the keeper submits.
- **Off-chain (source of truth):** the schedule definition (cadence, amount,
  next-run time) and its run history.
- **Mapping:** each `Schedule` run produces a stream/top-up transaction whose
  hash is recorded on the schedule run row; the stream itself is authoritative
  once indexed.

**Authorization.** Schedule execution is delegated to the keeper key, which is
scoped to funding operations only. The keeper cannot withdraw, change ownership,
or move funds outside the schedule's configured amount. Creating or editing a
schedule requires a wallet signature from the stream owner (or an org member
with the required role per ADR-001). Chain/network validation applies to every
keeper-submitted transaction exactly as for user-submitted ones.

**Idempotency.** Each schedule run is keyed by `(scheduleId, periodIndex)` with a
unique constraint so a retried or duplicated cron tick cannot double-pay. A run
is marked complete only after the transaction is confirmed and indexed; a
pending run is retried, not re-created.

**Migration consequences.** Adding schedule tables is additive. Existing streams
are unaffected and remain one-off. No contract migration is required. If a
future ADR moves scheduling on-chain, the backend schedule becomes a mirror and
must reconcile against on-chain state before disabling the cron.

---

## Financial Language & Risk-Disclosure Glossary

This glossary is the canonical definition of the financial terms surfaced in the
UI and API. Every user-facing label, API field description, and docs page must
use these terms with the meanings below. When a value is derived rather than
observed on-chain, the caveat column is mandatory disclosure.

| Term | Definition | Authoritative Source | Caveats / Risk Disclosure |
|------|------------|----------------------|---------------------------|
| **Streamed** | The portion of a stream's total amount that has vested by elapsed time up to the current ledger timestamp. | Contract `streamed_amount` view / `SorobanEventWorker` recomputation from `startTime`, `ratePerSecond`, and ledger time. | Time-based estimate between ledgers; not a settled balance. Do not present as withdrawable. |
| **Claimable** | The amount the recipient can withdraw right now: streamed amount minus already-withdrawn amount, clamped to the stream's remaining balance. | Contract `claimable_amount` view; mirrored by backend `withdrawnAmount` accounting. | Depends on the latest indexed ledger; may lag chain state by one poll interval. Never treat as guaranteed until a withdraw transaction confirms. |
| **Deposited** | The total amount the sender has funded into the stream (initial deposit plus any top-ups). | Contract `deposited_amount`; backend `Stream.depositedAmount` written by the indexer on `created` / `topped_up` events. | Custodial top-ups are server-signed via `KEEPER_SECRET_KEY`; a pending top-up is not yet deposited until the transaction is confirmed and indexed. |
| **Withdrawn** | The cumulative amount the recipient has successfully claimed from the stream. | Contract `withdrawn_amount`; backend `Stream.withdrawnAmount` updated on `withdrawn` events. | Additive mutation — the dual-indexer race (issue #808) can cause last-writer-wins drift until consolidation (issue #801). Treat as eventually consistent. |
| **Estimated** | Any value computed client- or server-side from time math rather than read from a confirmed on-chain state. | Frontend `useStreamEvents` projections; backend simulate endpoints (fee estimation only). | Must be labeled "estimated" in the UI. Never used for accounting, authorization, or payout decisions. |
| **Finalized** | A value backed by a confirmed, indexed on-chain transaction/event. | `StreamEvent` rows with a confirmed `transactionHash`; `Stream` fields written by `SorobanEventWorker`. | Finalized values can still be superseded by later events (e.g. a subsequent withdraw), but are never rolled back by estimation. |
| **Stale** | A displayed value whose backing indexer cursor has not advanced within the expected poll window, so it may no longer reflect chain state. | `IndexerState` cursor freshness vs. `SorobanEventWorker` poll interval; SSE heartbeat gaps. | Stale values must be visibly flagged in the UI and must not be treated as finalized. Recovery is via `replayFromLedger` (see `indexerService.ts`). |

### Consistency Rules

1. **Estimated vs. finalized.** Any value derived from time math is
   *estimated*; only values written from confirmed `StreamEvent` rows are
   *finalized*. UI must not render an estimated value with finalized styling.
2. **Stale vs. finalized.** If the `IndexerState` cursor is behind the expected
   poll window, all derived values are *stale* until the worker catches up. Stale
   is a superset of estimated: a stale finalized value is still stale.
3. **Claimable ≤ streamed − withdrawn.** This invariant must hold in every
   surface; a violation indicates indexer drift, not a UI bug.
4. **Deposited is monotonic.** Deposited only increases (deposit + top-ups); a
   decrease signals a data-integrity failure and must be surfaced, not hidden.

### Key UI & API Surfaces

These surfaces must use the glossary terms verbatim and honor the consistency
rules above:

| Surface | Terms Exposed | Notes |
|---------|---------------|-------|
| `GET /api/streams/:id` | streamed, claimable, deposited, withdrawn | Response fields map 1:1 to glossary terms; estimated fields are flagged. |
| `GET /api/streams` (list) | streamed, claimable | List projections are estimated between polls. |
| SSE `stream` events (`sse.service.ts`) | withdrawn, deposited, finalized | Event payloads are finalized once broadcast from the worker. |
| `GET /api/indexer/status` (`indexerService.ts`) | stale | Reports cursor freshness used to compute staleness. |
| Frontend `useStreamEvents` hook | estimated, stale | Client projections must be labeled estimated and flagged stale on heartbeat gaps. |

### Automated Coverage

Focused tests assert the glossary invariants and boundary transitions:

- **Stale → finalized transition:** a value flagged stale becomes finalized once
  the indexer cursor advances past the event ledger.
- **Estimated → finalized transition:** an estimated claimable value is replaced
  by the finalized on-chain value after the `withdrawn` event is indexed.
- **Boundary:** claimable clamps to zero when withdrawn equals streamed, and to
  the remaining balance when a top-up lands mid-stream.
- **Failure:** a deposited decrease is rejected/surfaced rather than silently
  applied.

---

## Read-Replica Consistency and Routing Policy

API reads may be served from a read replica, but only when the read is not
sensitive to replication lag. Authorization-sensitive reads and read-after-write
reads must always hit the primary. This section defines the routing defaults and
the client-visible signal used when a replica is behind the required ledger.

### Routing Defaults

| Read category | Route | Rationale |
|---------------|-------|-----------|
| Authorization / ownership checks (wallet auth, stream ownership, admin gating) | **Primary** | A stale replica could grant or deny access incorrectly. Never route these to a replica. |
| Read-after-write (a client reading a resource it just mutated) | **Primary** | Guarantees the client observes its own write. |
| Financial accounting reads (balances, withdrawn amounts, fee totals) | **Primary** | Preserves accounting invariants; lag could surface inconsistent totals. |
| Chain/network validation reads (ledger cursor, contract state checks) | **Primary** | Must reflect the latest validated ledger. |
| Public, non-sensitive listing reads (stream lists, event feeds, protocol stats) | **Replica allowed** | Tolerant of bounded lag; falls back to primary when lag exceeds the threshold. |

When in doubt, route to the primary. Replica routing is opt-in per read, not the
default.

### Lag Measurement Against the Required Ledger

Each replica read declares a **required ledger** — the minimum ledger the caller
needs to observe. The replica reports its applied ledger; lag is measured as:

```
lag = requiredLedger - replicaAppliedLedger
```

- `lag <= 0` → the replica is caught up; serve the read.
- `lag > 0` → the replica is behind the required ledger; do **not** serve stale
data silently.

### Client Signal When a Replica Is Behind

When a replica is behind the required ledger, the API does not return stale data
as if it were current. Instead it either:

1. **Falls back to the primary** for that read (default for replica-eligible
   reads), or
2. **Returns a lag signal** when fallback is not possible, using a documented
   response header/error so clients can retry against the primary.

This keeps existing response shapes compatible: successful responses are
unchanged, and the lag signal is additive (header/error code) rather than a
breaking change to the payload.

### Failover and Read-After-Write

- **Failover:** if the replica is unreachable, replica-eligible reads fall back
  to the primary. Authorization, accounting, and chain-validation reads already
  target the primary and are unaffected.
- **Read-after-write:** reads following a mutation are pinned to the primary for
  the consistency window so clients always observe their own writes.

These defaults preserve wallet authorization, chain/network validation,
financial accounting invariants, and secret-handling; replica routing never
weakens them.

---

## Indexer Ownership Model

Three files with overlapping names handle indexing and indexer management. Only
one of them is the source of truth for stream state.

| File | Role | Status |
|------|------|--------|
| `src/workers/soroban-event-worker.ts` (`SorobanEventWorker`) | **Source-of-truth indexer.** Polls Soroban RPC, decodes XDR events, persists `Stream` / `StreamEvent` rows, advances the `IndexerState` cursor, and broadcasts SSE updates. | **Active / source of truth.** Started by `src/workers/index.ts`. |
| `src/services/soroban-indexer.service.ts` (`SorobanIndexerService`) | **Legacy indexer being phased out.** A simpler duplicate poller that writes to the same DB rows and races with the worker on the same `Stream` / `StreamEvent` records (issue #801). | **Legacy — do not extend.** Removal tracked with functional consolidation (issue #801). Started directly from `src/index.ts`. |
| `src/services/indexerService.ts` | **Not an indexer at all.** Admin control-plane helpers (`getIndexerStatus`, `resetIndexer`, `replayFromLedger`) that read/reset the shared `IndexerState` cursor row and trigger the worker's poll loop. | **Active.** Name is misleading; kept alongside the legacy indexer above. |

### Key Rules

1. **When debugging indexing, read `src/workers/soroban-event-worker.ts`
   first.** It is the only file that persists canonical stream state.
2. **Do not add new behavior to `soroban-indexer.service.ts`.** It exists only
   for backwards compatibility while the double-indexer race (issue #801) is
   consolidated. Mirror any changes in `SorobanEventWorker` instead.
3. **`indexerService.ts` is control-plane only** — it never reads the chain; it
   manages the shared cursor and triggers replays.

### The Dual-Indexer Race

Both `SorobanEventWorker` and `SorobanIndexerService` poll the same Soroban RPC
for the same contract events and write to the same `Stream` and `StreamEvent`
rows. Because they run on independent timers, they can race:

- Both may process the same ledger simultaneously.
- Both write to the same `Stream` row (upsert), so the last writer wins —
  usually harmless for immutable fields but problematic for additive mutations
  like `withdrawnAmount` (issue #808).
- `StreamEvent` dedup via `@@unique([transactionHash, eventType])` prevents
  duplicate event rows, but does **not** protect stream state mutations.

**Mitigation:** Do not extend the legacy indexer. The consolidation (issue #801)
will remove `SorobanIndexerService` entirely.

### Naming Convention Plan

The team convention is kebab-case with a `.service.ts` suffix. Once functional
consolidation lands:

| Current Name | Expected Future Name |
|---|---|
| `indexerService.ts` | `indexer.service.ts` |
| `soroban-indexer.service.ts` | *(removed)* |

---

## Subscription Billing Adapter

The billing integration boundary (`src/integrations/billing/`) lets external
billing systems (Stripe-style subscriptions) create or update streams and
reconcile their status against on-chain events. It is an **adapter only** — it
never signs transactions and never bypasses wallet authorization. Stream
creation/updates still go through the normal wallet-signed path; the adapter
records the intent and links it to the resulting on-chain stream.

### Reconciliation Keys

Every billing record is linked to a stream by an explicit reconciliation key so
billing and on-chain state can be joined deterministically:

| Key | Source | Purpose |
|-----|--------|---------|
| `invoiceId` | Billing system | Idempotency key for a single invoice. Unique per adapter. |
| `subscriptionId` | Billing system | Groups invoices belonging to one subscription. |
| `streamId` | On-chain (`Stream.id`) | Links the billing record to the canonical stream row. |
| `eventSequence` | Billing webhook | Monotonic sequence/timestamp used to order webhooks. |

`(invoiceId)` is the idempotency key: a repeated webhook for the same invoice is
a **no-op** (returns the previously recorded result) rather than creating a
duplicate stream or double-applying an update. `(subscriptionId, streamId)` is
the reconciliation key used to detect divergence.

### Duplicate-Invoice Behavior

- The first webhook for an `invoiceId` creates/updates the stream and persists
  the mapping.
- Any subsequent webhook with the same `invoiceId` is deduplicated: the adapter
  returns the stored result and does **not** re-apply the mutation.
- If a duplicate arrives with a *different* payload for the same `invoiceId`,
  the adapter rejects it as a conflict (surfaced to the caller) instead of
  silently overwriting state.

### Out-of-Order Webhooks

Webhooks may arrive out of order. The adapter compares `eventSequence` against
the last applied sequence for the subscription:

- `eventSequence` **greater** than the last applied → apply and advance.
- `eventSequence` **equal** → treated as a duplicate (idempotent no-op).
- `eventSequence` **less** than the last applied → stale; ignored (not applied),
  but recorded so operators can see late deliveries.

This makes delivery order irrelevant: the highest sequence wins and replays are
safe.

### Resolving Divergence

Divergence means billing state and on-chain stream state disagree (e.g. billing
marks a subscription `active` but the stream is `cancelled` on-chain). To
resolve:

1. **On-chain state is authoritative** for stream lifecycle
   (`active`/`paused`/`cancelled`/`completed`). The adapter never mutates chain
   state to match billing.
2. Run reconciliation by joining on `(subscriptionId, streamId)` and comparing
   the billing status to the latest `StreamEvent` for that stream.
3. Divergent records are reported (not auto-corrected) so an operator can
   decide whether to cancel the subscription in billing or open a wallet-signed
   on-chain action. The adapter must not weaken wallet authorization to
   "fix" divergence automatically.

---

## SSE Broadcast Flow

The SSE (Server-Sent Events) subsystem delivers real-time contract event
notifications to connected frontend clients. The full SSE architecture (scaling,
memory, security) is documented in
[`docs/SSE_ARCHITECTURE.md`](./SSE_ARCHITECTURE.md).

### End-to-End Path

```
Soroban RPC
    │  SorobanEventWorker polls for new contract events
    ▼
SorobanEventWorker (src/workers/soroban-event-worker.ts)
    │  decode XDR → upsert Stream → insert StreamEvent
    ▼
PostgreSQL (via Prisma)
    │  Stream + StreamEvent rows updated
    ▼
SSE broadcast (src/services/sse.service.ts)
    │  sseService.broadcastToStream(streamId, event, data)
    │  sseService.broadcastToUser(publicKey, event, data)
    │  sseService.broadcastToAdmin(event, data)
    │
    ├──► [Single instance]  Direct write to in-memory client registry
    │
    └──► [Multi-instance]   Redis Pub/Sub
                             │  publish to sse:stream:<id>, sse:user:<address>
                             ▼
                             All backend instances subscribe
                             │  rebroadcast to local connected clients
                             ▼
                         Frontend (useStreamEvents hook)
```

### Broadcast Channels

The worker uses three broadcast entry points depending on the event:

| Method | When Used | Target Audience |
|--------|-----------|-----------------|
| `sseService.broadcastToStream(streamId, event, data)` | Stream lifecycle events (created, topped_up, withdrawn, cancelled, completed, paused, resumed) | Clients subscribed to that specific stream ID or `*` |
| `sseService.broadcastToUser(publicKey, event, data)` | (Reserved for user-scoped events) | Clients subscribed to `user:<publicKey>` or `*` |
| `sseService.broadcastToAdmin(event, data)` | Protocol-level events (fee_collected, fee_config_updated, admin_transferred) | The admin user identified by `ADMIN_PUBLIC_KEY` env var |

### Multi-Instance Fanout

When `REDIS_URL` is configured, broadcasts go through Redis Pub/Sub instead of
direct in-memory writes:

1. The originating instance publishes `{ event, data }` to
   `sse:stream:<id>` or `sse:user:<address>`.
2. Every backend instance subscribes via `psubscribe('sse:stream:*',
   'sse:user:*')` and rebroadcasts to its own local clients.
3. This means events reach all connected clients regardless of which backend
   instance they are connected to.

### Client Connection Limits

| Limit | Default | Env Var |
|-------|---------|---------|
| Max SSE connections per server | 10,000 | `MAX_SSE_CONNECTIONS` |
| Max connections per IP | 5 | Hardcoded |
| Max connections per authenticated user | 10 | Hardcoded |

Slow clients (write buffer ≥ 64 KB) are automatically dropped to protect
throughput for healthy clients.

---

## Shared Stream Review Links

Stream owners can share a read-only review of a stream via a scoped link. The
link exposes **only** the fields the owner explicitly selects as public; it never
reveals wallet addresses, session data, tokens, or secrets.

### Expiry

- Every share link has a TTL. The default is **7 days** and can be configured
  per link (bounded by a server-side maximum).
- Expiry is evaluated server-side on every read; an expired link returns a safe
  `404 Not Found` (identical to an unknown token) so expiry cannot be probed.

### Revocation

- The stream owner can revoke a link at any time before expiry. Revocation is
  immediate and idempotent.
- Revoked links return the same safe `404 Not Found` response as expired or
  unknown links.

### Privacy Boundary

- The shared payload is built from an explicit allow-list of public fields
  (e.g. stream id, status, amounts, timestamps). Private wallet/session data is
  never included.
- The share endpoint is strictly read-only: any mutating method or attempt to
  access non-public data is rejected with `403 Forbidden`.

---

## Keeper-Key Authorization Model

FlowFi splits transaction signing into two categories: custodial (server-signed)
and non-custodial (wallet-signed). The signing key determines who is responsible
for the transaction.

### Action Signing Matrix

| Action | Signer | Mechanism |
|--------|--------|-----------|
| **Top-up** | Server (custodial) | Backend submits the transaction using `KEEPER_SECRET_KEY`. The frontend sends only the stream ID and amount. |
| **Withdraw** | Wallet (non-custodial) | Frontend builds and signs the transaction via the connected wallet (Freighter). The backend simulate endpoint exists for fee estimation only. |
| **Pause / Resume** | Wallet (non-custodial) | Same as withdraw — frontend-signed. Backend simulate endpoints exist for fee estimation but do not submit. |
| **Create stream** | Wallet (non-custodial) | Frontend signs via wallet and submits directly to the Soroban RPC. |

### The `KEEPER_SECRET_KEY`

- Stored as an environment variable on the backend.
- Loaded by `src/services/sorobanService.ts` via
  `process.env.KEEPER_SECRET_KEY`.
- Used **exclusively** by the top-up flow. The `topUpStream` function builds
  the transaction, signs it with the keeper keypair, and submits it to the
  Soroban RPC.
- If `KEEPER_SECRET_KEY` is not configured, `topUpStream` throws
  `'KEEPER_SECRET_KEY not configured'` and the request returns HTTP 500.
- The cancel endpoint (`src/controllers/stream/cancel.ts`) also reads
  `KEEPER_SECRET_KEY` but only to check whether the server wallet is configured;
  the actual cancel transaction is wallet-signed by the sender.

### Security Boundary

> **Do not wire pause/resume/withdraw to a server-side submit path.** Only
> `top-up` is intentionally custodial. All other mutating actions must be
> wallet-signed by the user to preserve the non-custodial security model.

The keeper key is a server-side secret and is never exposed to the frontend.

### Cancellation

A handoff can be cancelled by the user (wallet returns `status=cancelled`) or by
the application (timeout / navigation away). Both paths resolve the pending
promise with a `DeepLinkCancelledError` and never leave a dangling listener.

### Return-Link Validation

Return callbacks are untrusted input. The adapter rejects a callback when:

- Required fields (`status`, `networkPassphrase`) are missing or malformed.
- `status` is not one of `signed` / `cancelled` / `rejected`.
- A `signed` response is missing a well-formed `signedXdr`.
- The callback origin does not match the configured return origin.

Malformed callbacks surface as `DeepLinkValidationError` and are never treated
as a successful signature.

### Network Matching

The `networkPassphrase` in the return callback must equal the passphrase the
request was built for. A mismatch (e.g. mainnet response for a testnet request)
is rejected with `DeepLinkNetworkMismatchError` before the signed XDR is used.
This preserves chain/network validation and prevents cross-network replay.

## Verifier-Backed Conditional Release Policies

Some streams gate accrual or release on the result of an external verifier
(e.g. an oracle, attestation service, or off-chain job runner). This section
defines the trust model and failure semantics for those streams. The interface
is additive: streams without a configured verifier keep the existing
unconditional accrual/release behavior.

### Verifier Identity

- A verifier is identified by a stable `verifierId` (opaque string) plus the
  on-chain `verifierAddress` that is authorized to submit results. Both are
  configured at stream creation and are immutable for the life of the stream.
- Only results whose `verifierAddress` matches the stream's configured address
  are accepted. Results from any other address are rejected and never mutate
  stream state.
- The backend treats the verifier as an **untrusted external input**: it
  validates identity and shape, but does not assume the verifier is honest or
  available.

### Trust Assumptions

> **The verifier is trusted only to report its own result — not to move funds,
> change stream parameters, or bypass wallet authorization.** Release still
> requires the normal wallet-signed withdraw path; the verifier result only
> determines *whether* accrual/release is permitted, never *who* may trigger it.

- Verifier results are advisory gates. They cannot weaken wallet authorization,
  chain/network validation, or financial accounting invariants.
- The verifier's correctness (e.g. whether a job truly succeeded) is outside the
  protocol's trust boundary; the protocol only enforces that a result came from
  the configured verifier and was well-formed.

### Timeout, Failure, and Replay Semantics

| Condition | Behavior |
|-----------|----------|
| **No result yet** | Stream accrues/releases per its default policy until a valid result arrives. |
| **Timeout** | If no valid result arrives within the configured `verifierTimeoutSeconds`, the stream falls back to its configured failure mode (see below). |
| **Verifier unavailable** | Treated as a timeout once the deadline passes; the failure mode applies. |
| **Malformed response** | Rejected without mutating state; the stream remains in its pre-result state and the timeout clock continues. |
| **Wrong verifier identity** | Rejected without mutating state (same as malformed). |
| **Replay / duplicate result** | Results are keyed by `(streamId, verifierId, nonce)`. A result whose nonce was already consumed is ignored; it never re-triggers release. |

**Failure modes** (configured per stream):

- `block` — accrual/release is blocked until a valid result arrives (default).
- `release` — accrual/release proceeds as if the verifier returned success.

### Operational Notes

- Malformed or unavailable verifier responses are logged with the stream ID and
  verifier ID but never surface raw verifier payloads to clients.
- The timeout boundary is inclusive of the deadline: a result arriving exactly at
  `verifierTimeoutSeconds` is accepted; anything later is treated as a timeout.
- Replay protection relies on the consumed-nonce set; operators must not reuse
  nonces when re-submitting results.
