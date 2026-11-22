# Backend

This document describes the backend services, their public interfaces, and the
operational contracts they must uphold. Keep it in sync with code changes that
alter externally observable behavior.

## Accounting export adapters

The accounting export adapters map FlowFi stream and event records to a
documented accounting interchange format (a JSON journal of balanced entries)
without losing ledger or transaction provenance. They live under
`backend/src/integrations/accounting/` and are consumed by the export job and
partner integrations.

### Stable identifiers

Every exported entry carries stable identifiers so downstream ledgers can
deduplicate and reconcile across re-exports:

- `streamId` — the FlowFi stream identifier (unchanged across lifecycle).
- `eventId` — the originating event identifier; unique per lifecycle event.
- `entryId` — deterministic, derived from `(streamId, eventId, entryKind)` so
  re-running an export produces identical identifiers.
- `txHash` / `network` — chain provenance, preserved verbatim when present.

Identifiers are never regenerated from timestamps or array positions.

### Rounding

- All monetary amounts are exported as integer minor units (e.g. cents) using
  the token/asset decimals recorded on the stream.
- Rounding is half-up (`ROUND_HALF_UP`) applied once, at the point of
  conversion from on-chain base units to the export minor unit.
- No intermediate rounding is performed; sums are computed in base units and
  converted once to avoid drift.
- The rounding mode and scale are recorded on each export batch header.

### Fees

- Protocol and network fees are exported as separate debit entries linked to
  the parent stream entry via `entryId`/`parentEntryId`.
- Fees are never netted into the principal amount; provenance of each fee is
  retained (`feeKind`, `txHash`).
- Zero-fee events emit no fee entry.

### Timezone

- All timestamps are normalized to UTC and exported as RFC 3339 with a `Z`
  suffix.
- The source timezone (if any) is not inferred; records without a timestamp
  are rejected rather than defaulted.
- Export batch headers record `timezone: "UTC"`.

### Reversal entries

- Reversals (cancellations, refunds, failed settlements) emit a compensating
  entry that references the original via `reversesEntryId`.
- Reversal entries negate the original amount and reuse the original
  `streamId`/`txHash` provenance; they never mutate the original entry.
- A reversal without a resolvable original entry is a hard failure.

### Testing

- Golden-file tests under `backend/test/integrations/accounting/golden/` cover
  representative lifecycle histories (create → fund → withdraw → cancel,
  fee-bearing settlements, and reversals).
- Focused unit tests cover boundary cases: zero amounts, maximum decimals,
  missing timestamps, unresolvable reversals, and duplicate re-exports.

## Compatibility

```bash
npm test
```

### Indexer soak / stability test

The indexer includes a long-running soak test that drives event polling, SSE fanout, webhook dispatch, and replay under sustained representative traffic. It asserts that memory growth and queue depths stay within published bounds over a repeatable window.

Run it with:

## Server-Sent Events (SSE)

The backend exposes an SSE endpoint (`/v1/streams/events`) to stream real-time updates to the frontend whenever on-chain stream events are indexed.

### Consuming stream events from the SDK

The SDK ships framework-neutral React hooks for the stream lifecycle so consumers do not have to hand-roll SSE wiring. They are optional — the core SDK has no React dependency, and the hooks live in a separate entry point that only imports React when you use them.

- `useStreamState(streamId, { walletAddress })` — loads the current stream state and subscribes to `/v1/streams/events` for updates. It refetches when `streamId` or `walletAddress` changes, aborts in-flight requests and closes the `EventSource` on unmount or dependency change, and ignores responses that arrive after a newer request or after unmount so stale data never overwrites fresh state.
- `useStreamEvents(streamId, { walletAddress, onEvent })` — subscribes to updates only, for consumers that already hold state elsewhere.

Both hooks are safe to call during server rendering: they do not open an `EventSource` or issue a fetch until after mount, so SSR output is stable and hydration does not mismatch.

```tsx
import { useStreamState } from '@flowfi/sdk/react';

function StreamBalance({ streamId, walletAddress }: { streamId: string; walletAddress: string }) {
  const { data, error, isLoading } = useStreamState(streamId, { walletAddress });
  if (isLoading) return <span>Loading…</span>;
  if (error) return <span>Failed to load stream</span>;
  return <span>{data?.remainingAmount}</span>;
}
```

The suite records a deterministic dataset definition and the query plans for
each representative query. Runs are compared against these recorded fixtures so
results are stable and comparable across releases. Fixtures live alongside the
suite and are regenerated only when the schema or query set intentionally
changes.

#### Regression thresholds

Each query has a bounded regression threshold (maximum allowed latency and plan
regression). A run fails when a query exceeds its threshold, and passes when it
is at or just under the threshold. Empty or minimal datasets are handled as a
boundary case and must not error.

Environment knobs (all optional):

| Variable | Default | Description |
| --- | --- | --- |
| `SOAK_DURATION_MS` | `30000` | Length of the soak window in milliseconds. |
| `SOAK_TICK_MS` | `50` | Interval between simulated traffic ticks. |
| `SOAK_MAX_HEAP_GROWTH_BYTES` | `67108864` (64 MiB) | Maximum allowed heap growth across the window. |
| `SOAK_MAX_QUEUE_DEPTH` | `1000` | Maximum allowed depth for any queue (polling backlog, SSE subscriber buffers, webhook dispatch, replay). |

Thresholds and reproduction steps are documented in [`docs/indexer-operations.md`](docs/indexer-operations.md).

## Documentation

Structured JSON logs generated by Winston (`backend/src/logger.ts`) attach a `requestId` correlation ID via `AsyncLocalStorage` (`requestContext`):
- **HTTP Requests:** Set via `requestIdMiddleware` (`X-Request-ID` header or auto-generated UUID).
- **Worker Poll Batches:** Each poll cycle in `SorobanEventWorker` runs in `requestContext.run({ requestId: randomUUID() }, ...)` so all event logs and error traces share a single ID per cycle.
- **Admin Replays:** Replays triggered via `repl

/* … truncated 174 chars — edit only what you need near the top … */
