# Architecture

This document explains how setpoint is built and why. It is intended for
contributors who want to understand the system before changing it. For usage and
the full API/CLI reference, see [`README.md`](./README.md).

## 1. Overview

setpoint is a long-running [Bun](https://bun.sh) + TypeScript daemon that
manages multiple SpaceMolt game accounts at once. For each account it maintains a
live API session, mirrors the account's game state into a local SQLite database,
and exposes a local HTTP API (and a thin CLI, `smctl`) for automation.

The central design idea is a **declarative model**: callers specify a desired
end-state, not a sequence of API calls. Instead of "undock, jump to sol, dock at
the station, refuel", a caller submits a goal like `navigate-to-system` with
`targetSystemId: "sol"`, and setpoint inspects current state, plans the
necessary steps, and executes them. Goals are **idempotent**: each one checks
whether it is already satisfied before acting, so submitting a goal that is
already true (e.g. the ship is already in the target system) succeeds immediately
without spending a game tick.

The system is built in three layers of increasing scope:

1. **Primitives** — single-action declarative goals (travel, dock, refuel, buy,
   sell).
2. **Compound goals** — multi-step sequences built from primitives (travel +
   dock + refuel).
3. **Loops** — repeating behaviours (mine until full → sell → repeat).

Every account is fully isolated: it has its own session, its own state rows, and
at most one running loop. Accounts never share sessions, state, or queues.

### Why these constraints shape the design

The SpaceMolt game server imposes two facts that drive most of the architecture:

- **Mutations are tick-bound and rate-limited.** The server executes at most one
  mutation per 10-second game tick per account, and blocks the HTTP response
  until that tick runs. Queries (`get_state`, `get_cargo`, `get_nearby`, …) are
  unlimited. This is why setpoint tracks a `ticksUsed` count on every goal
  result and prefers reading cached local state over re-querying.
- **Sessions are in-memory and ephemeral.** The game server holds sessions in
  memory with a 30-minute inactivity timeout, and restarts regularly (killing all
  sessions). Per-IP rate limits cap session creation and auth attempts. This is
  why session creation is staggered, keepalive runs on a timer, and 401s trigger
  a shared, paced recovery rather than an immediate re-login storm.

## 2. The layered goal engine

All three layers share a single contract defined in
[`src/dispatcher/goals.ts`](./src/dispatcher/goals.ts):

```ts
interface Goal {
  readonly name: string;
  execute(ctx: GoalContext): Promise<GoalResult>;
}
```

A `GoalResult` reports `success`, a human-readable `message`, whether the goal was
`alreadySatisfied`, and `ticksUsed` (mutation actions consumed). The
`GoalContext` gives a goal everything it needs to act:

- `endpoints` — typed API wrappers (see §5).
- `state` — a snapshot of current game state, read from the local store.
- `readLocalState()` — re-read the store with no API call. Safe immediately after
  a mutation, because the store is updated by the response pipeline before the
  mutation promise resolves.
- `refreshState()` — fetch fresh state from the API (used for initial sync or
  when transit polling is required).
- `signal` — an `AbortSignal` for external cancellation.

The goal-naming convention follows the declarative model: goals are named for the
desired state, not the action taken — `navigate-to-system` rather than `jump`,
`ensure-fueled` rather than `refuel`.

### Primitives

Primitives live in [`src/dispatcher/primitives/`](./src/dispatcher/primitives/).
Each is a single declarative goal that: (1) checks whether the desired state is
already satisfied, (2) validates prerequisites, (3) takes the minimal API action,
and (4) returns a result.

Example — [`navigate-to-system.ts`](./src/dispatcher/primitives/navigate-to-system.ts):

- If the ship is already in the target system, it returns `alreadySatisfied`
  immediately.
- Otherwise it plans a path with the `find_route` query (free, no tick cost),
  undocks if needed, then jumps each hop in sequence (one tick per jump).
- On a failed jump it refreshes state and re-plans once from the ship's actual
  position — the game server occasionally rejects a valid hop, and "you are
  already in X" actually means the jump succeeded. It checks the abort signal
  between hops so a long multi-hop route can be cancelled promptly.

Other primitives in this layer include `dock-at`, `go-to-poi`, `ensure-fueled`,
`ensure-repaired`, `ensure-undocked`, `buy-items`, `sell-or-deposit-cargo`,
`jettison-cargo`, the mission goals (`accept-mission`, `complete-mission`,
`abandon-mission`), module goals (`install-mod`, `uninstall-mod`), and the
faction-storage goals (`deposit-to-faction-storage`,
`withdraw-from-faction-storage`, `gift-to-player`).

### Compound goals

Compound goals live in [`src/dispatcher/compounds/`](./src/dispatcher/compounds/).
A compound assembles primitives into a multi-step sequence and runs them in order
via the sequence runner ([`src/dispatcher/sequence.ts`](./src/dispatcher/sequence.ts)),
short-circuiting if any step fails. The result type
(`CompoundGoalResult`) carries the per-step results so callers can see exactly
which step ran and what it returned.

Example — [`mining-run.ts`](./src/dispatcher/compounds/mining-run.ts) composes:

1. `NavigateToSystem` — jump to the target system.
2. `GoToPoi` — travel to the asteroid belt.
3. `EnsureUndocked` — undock (can't mine while docked).
4. `MineUntilFull` — mine until cargo reaches the fullness threshold.

It refreshes state between the travel phase and the mining phase, and reports the
combined `ticksUsed` and whether all steps were already satisfied. Other compounds
include `prepare-at-station`, `sell-at-station`, `buy-at-station`,
`load-at-station`, `unload-at-station`, `enhanced-mining-run`, `mine-with-jettison`,
and `fuel-rescue`.

### Loops

Loops live in [`src/dispatcher/loops/`](./src/dispatcher/loops/) and are driven by
the generic loop engine in [`src/dispatcher/loops.ts`](./src/dispatcher/loops.ts).
`runLoop(factory, ctx, options)` repeatedly:

1. Checks the abort signal and the optional `shouldContinue` predicate.
2. Builds a fresh goal from `factory(currentState)` (so each iteration plans from
   current state).
3. Executes the goal.
4. On success: refreshes state and advances the iteration counter.
5. On failure or a thrown exception: waits `retryDelayMs` (default 30s) and
   **retries the same iteration** without advancing. Consecutive failures are
   counted; after `maxConsecutiveFailures` (default 10) the loop stops.
6. A successful iteration resets the consecutive-failure counter.

Cancellation and `shouldContinue` stops are treated as successful completions, not
failures. `RateLimitError`s override the retry delay with the server's
`retry-after` value, and retry delays are abortable so a stop request takes effect
promptly. The engine keeps only the most recent 100 iteration results in memory.

Loop definitions (e.g. `mining-loop`, `enhanced-mining-loop`, `trading-loop`,
`hauling-loop`, `storage-transfer-loop`) supply the per-iteration
goal factory. The user-facing loop types and their option schemas are documented
in the README. Loop configs are persisted to disk (`config/loops/<player_id>.json`)
when a loop starts and auto-resume on daemon restart; the file is removed when the
loop stops or completes.

## 3. State model

The local SQLite database is always kept as fresh as the last API response, so
reads never need to hit the game server (and never cost a tick).

### Storage

The schema ([`src/state/database.ts`](./src/state/database.ts)) is a single
`game_state` table keyed by `account_id`, with one JSON text column per state
section: `player`, `ship`, `cargo`, `location`, `modules`, `skills`, `missions`,
`queue`, plus `updated_at` and the persisted `session_id` /
`session_expires_at`. A separate `jobs` table tracks async goal jobs. WAL mode is
enabled for concurrent reads.

The store ([`src/state/store.ts`](./src/state/store.ts)) wraps the table.
`applyUpdate` performs **partial updates**: only sections that are present
(non-`undefined`, non-`null`) in an incoming `V2GameState` are written, so a query
that returns only `cargo` does not clobber the stored `ship`. The store also
persists and reads session info for resumption across restarts.

### The updater flow

Every mutation response's `structuredContent` contains a partial `V2GameState`.
The flow that keeps the database current:

1. The `Session` calls every registered response callback after each successful
   API call (`onResponse`, in [`src/api/session.ts`](./src/api/session.ts)).
2. The account manager wires each session's `onResponse` to
   `StateUpdater.processResponse(accountId, structuredContent)`
   ([`src/accounts/manager.ts`](./src/accounts/manager.ts)).
3. The updater ([`src/state/updater.ts`](./src/state/updater.ts)) extracts the
   `V2GameState` fields, calls `store.applyUpdate`, and emits a
   `StateChangeEvent` listing the changed sections so other components can react.

The updater also handles two special shapes: travel responses (which carry
location changes — destination POI and auto-undock — outside the standard
`V2GameState` shape) and login responses (which deliver full initial
player/ship/system state in a different top-level structure).

Because this callback runs *before* a mutation's promise resolves, a goal can call
`readLocalState()` right after a mutation and see the updated values without an
extra API round-trip. The raw passthrough endpoint also runs responses through the
updater, so even direct API calls keep the cache current.

## 4. Session lifecycle

A `Session` ([`src/api/session.ts`](./src/api/session.ts)) owns one account's
connection to the game server and moves through the states `disconnected →
connecting → active → recovering`.

- **Connect.** `connect()` creates an API session, logs in, captures initial
  state from the login response, and starts a keepalive timer.
- **Keepalive.** Because the server times out idle sessions after 30 minutes, a
  timer polls `get_state` at a fixed interval (default 10 minutes) to bump
  `LastSeen` and refresh the recorded expiry. The poll response also flows through
  the state updater, so keepalive doubles as a periodic state refresh.
- **401 recovery.** When an action raises `SessionExpiredError` (typically after a
  server restart dropped the session), the session triggers `ensureRecovered()`,
  which reconnects and retries the action once. Recovery is guarded by a shared
  promise so concurrent callers join a single recovery rather than racing to
  create multiple sessions, and `RateLimitError`s during recovery wait the
  server's `retry-after` without consuming a recovery attempt.
- **Resume across daemon restarts.** Session IDs and expiries are persisted to
  the store. On startup, `tryResume()` validates a stored session with a single
  `get_state` query; if it succeeds, the daemon reuses the session (no auth call,
  no rate-limit cost). If it fails, the account falls back to a full connect.
- **Busy-ship polling.** The game server returns `action_in_progress` or
  `in_transit` when the ship is mid-action or mid-jump. The session polls through
  these (every ~12s, up to ~25 attempts) until the action resolves, which also
  covers reconnecting while a ship is still travelling server-side.

### Rate-limit pacing and isolation

The account manager ([`src/accounts/manager.ts`](./src/accounts/manager.ts))
serialises auth calls through a shared `AuthRateLimiter` (an `AuthSlot`
implementation) so concurrent reconnects are spaced at least `staggerDelayMs`
apart (default 6.5s, sized for the 10 auth/min limit). Startup connection
(`connectAll`) staggers session creation the same way, but **skips the stagger for
accounts with a resumable stored session**, since resume uses only a query. Each
account gets its own `Session` and `GameEndpoints`, keyed by `player_id` — there
is no shared session, state, or queue between accounts.

Accounts can also be added at runtime via a background queue
(`queueAccount` / `queueByCredentials`): the API returns immediately and the
manager connects accounts one at a time with the stagger delay between them.

## 5. HTTP API and CLI layering

The API access path is layered so each level has a single responsibility:

```
SpaceMoltClient → Session → GameEndpoints → goals → server handlers → Router
        (HTTP)    (auth/      (typed         (declarative)  (HTTP API)
                   recovery)   wrappers)
```

- **`SpaceMoltClient`** ([`src/api/client.ts`](./src/api/client.ts)) — the
  low-level HTTP client. It builds requests, parses the response envelope
  (`result`, `structuredContent`, `notifications`, `session`, `error`), and
  classifies errors (`ApiError`, `RateLimitError`, `SessionExpiredError`,
  `HttpError`). It does **not** manage sessions.
- **`Session`** — adds the `X-Session-Id` header, observes responses (state
  updates), and handles expiry/recovery and busy-ship polling.
- **`GameEndpoints`** ([`src/api/endpoints.ts`](./src/api/endpoints.ts)) — typed
  wrappers over individual game actions (`jump`, `dock`, `refuel`, `findRoute`,
  …), using types generated from the OpenAPI spec.
- **Goals** — the declarative layer described in §2, which calls endpoints.
- **Server handlers** ([`src/server/handlers.ts`](./src/server/handlers.ts)) —
  translate HTTP requests into goal/loop/raw operations and read state from the
  store.
- **`Router`** ([`src/server/router.ts`](./src/server/router.ts)) — path matching;
  routes are registered in [`src/server/index.ts`](./src/server/index.ts).

The HTTP server binds to loopback (`127.0.0.1`) by default because it has no
authentication; `SM_HOST` can override the bind interface on a trusted host. Sync
goal requests have their per-request deadline disabled, but Bun's server-level
idle timeout (capped at 255s) still applies — long-running goals should be
submitted to the async endpoint, which returns a `job_id` immediately and runs the
goal in the background (tracked in the `jobs` table and resumable after a restart).

The CLI, **`smctl`** ([`src/cli/`](./src/cli/)), is a thin HTTP wrapper. Each
command maps to one daemon endpoint: `src/cli/commands.ts` dispatches to
`DaemonClient` ([`src/cli/client.ts`](./src/cli/client.ts)), which issues the HTTP
request and formats the JSON response. `DaemonClient` distinguishes connection
failures (daemon unreachable — retried) from timeouts (daemon slow — reported
immediately), and uses a longer request timeout for sync goals than for ordinary
commands. Because the CLI is a pure wrapper, every command corresponds exactly to
an HTTP route, and tests assert the URL/method each command calls.

The `raw` passthrough (`POST /accounts/:playerId/raw`, and the `smctl raw`
command) sends a call straight to the game API through the managed session for
operations not yet wrapped in a goal. Its response still flows through the state
updater.

## 6. Project structure

```
setpoint/
├── ARCHITECTURE.md                 # This document
├── README.md                       # Usage, CLI, and HTTP API reference
├── biome.json                      # Linter + formatter config
├── tsconfig.json                   # TypeScript (strict) config
├── package.json
├── scripts/
│   └── bump-version.ts             # Patch-version bump used by deploy
├── src/
│   ├── index.ts                    # Entry point — boot DB, manager, server; connect accounts
│   ├── generated/
│   │   └── api-types.ts            # Auto-generated from the OpenAPI spec (never hand-edited)
│   ├── api/                        # SpaceMolt API client layer
│   │   ├── client.ts               # Low-level HTTP client, envelope parsing, error classification
│   │   ├── session.ts              # Session lifecycle, keepalive, 401 recovery, busy-ship polling
│   │   └── endpoints.ts            # Typed per-action endpoint wrappers
│   ├── accounts/                   # Multi-account management
│   │   ├── manager.ts              # Account lifecycle, connection queue, rate-limit staggering
│   │   └── config.ts               # Account config schema, loading, credential parsing
│   ├── state/                      # Game state tracking
│   │   ├── database.ts             # SQLite schema (game_state + jobs)
│   │   ├── store.ts                # Per-account state store, partial updates
│   │   └── updater.ts              # Applies API responses to state, emits change events
│   ├── dispatcher/                 # Declarative goal engine
│   │   ├── goals.ts                # Goal / GoalContext / GoalResult contracts and helpers
│   │   ├── sequence.ts             # Sequential goal execution
│   │   ├── sequence-goal.ts        # Sequence wrapped as a Goal
│   │   ├── loops.ts                # Generic loop engine (runLoop)
│   │   ├── primitives/             # Single-action goals (navigate, dock, refuel, buy, sell, …)
│   │   ├── compounds/              # Multi-step goal sequences (mining-run, sell-at-station, …)
│   │   └── loops/                  # Loop definitions (mining, trading, hauling, …)
│   ├── server/                     # Local HTTP API
│   │   ├── index.ts                # Server startup and route registration
│   │   ├── router.ts               # Route matching
│   │   ├── handlers.ts             # Request handlers
│   │   ├── job-manager.ts          # Async job lifecycle (backed by the jobs table)
│   │   ├── loop-manager.ts         # Loop lifecycle, persistence, and resume
│   │   └── schemas.ts              # Goal/loop schema registry served at /schemas
│   ├── cli/                        # smctl CLI client
│   │   ├── index.ts                # Entry point
│   │   ├── commands.ts             # Command dispatch and help text
│   │   ├── client.ts               # HTTP client for daemon communication
│   │   └── output.ts               # Output formatting
│   └── util/                       # Shared utilities
│       ├── logger.ts               # Logging + token redaction
│       ├── errors.ts               # Typed error classes
│       └── bandwidth-tracker.ts    # Request/byte accounting
├── tests/                          # Mirrors src/ structure; fixtures under tests/fixtures/
├── config/                         # Runtime config (gitignored): accounts/, loops/, registration
└── data/                           # SQLite database (gitignored)
```

### Notable endpoints not mirrored by a single CLI command

Beyond the account/state/goal/loop endpoints documented in the README, the server
also exposes:

- `GET /dashboard/data` — aggregated JSON status for all accounts (loop status,
  running-job flags, recent jobs).
- `GET /schemas/goals` and `GET /schemas/loops` — machine-readable schemas for the
  registered goal and loop types.
- `GET /accounts/:playerId/system` and
  `GET /accounts/:playerId/system/:systemId` — system data queried through a
  specific account's session.
- `POST /accounts/:playerId/goal/async` and `GET /jobs/:jobId` — submit a goal as
  a background job and poll its result.
- `DELETE /accounts/:playerId/abort` — release an account from all in-progress
  work.

## 7. Key timing constants

These constants interact, and understanding them is essential before debugging any
lock, retry, or timeout issue.

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `ACTION_IN_PROGRESS_WAIT_MS` | 12s | `src/api/session.ts` | Wait before re-polling when the game server reports a pending action (or in-transit). |
| `MAX_ACTION_IN_PROGRESS_RETRIES` | 25 | `src/api/session.ts` | Max busy-ship polls before giving up (covers a worst-case reconnect mid-travel). |
| `keepaliveIntervalMs` | 10min | `src/api/session.ts` | Interval between keepalive `get_state` polls. |
| Session inactivity timeout | 30min | game server | Idle sessions are dropped server-side; keepalive prevents this. |
| `staggerDelayMs` | 6.5s | `src/accounts/manager.ts` | Min spacing between auth calls / session creations (10 auth/min limit). |
| Loop `retryDelayMs` | 30s | `src/dispatcher/loops.ts` | Delay before retrying a failed loop iteration (overridden by `retry-after` on rate limits). |
| Loop `maxConsecutiveFailures` | 10 | `src/dispatcher/loops.ts` | Consecutive iteration failures before a loop stops. |
| `DaemonClient.requestTimeoutMs` | 30s default, 5min for sync goals | `src/cli/client.ts` | CLI per-request timeout. |
| `SpaceMoltClient` retry delay | 5s | `src/api/client.ts` | Delay between retries on 5xx errors. |
| Server `idleTimeout` | 255s | `src/server/index.ts` | Bun server-level idle timeout; long goals must use the async endpoint. |

A "slow" mutation response (≈1 minute wall clock) is usually a command queued
behind a ship in transit — `jump` holds the HTTP response for the full,
distance-based transit, and a further mutation submitted during transit is held
server-side until arrival. Queries always return instantly. When a failure takes
several seconds that should have been instant, a timeout-plus-retry cycle is
involved; work backwards from the timing to identify which constant matches.

## Conventions for contributors

- **Types are generated, never hand-written.** All request/response types come
  from the OpenAPI spec via `bun run generate`, which reads a vendored
  `openapi/spacemolt-v2.json` if present and otherwise fetches the live spec.
  Regenerate rather than editing `src/generated/`.
- **Every mutation response updates state.** No mutation path should bypass the
  state updater.
- **Per-account isolation is invariant.** Sessions, state, and queues must never
  be shared across accounts.
- **Respect rate limits proactively.** Pace auth/session calls rather than relying
  on 429 responses to slow down.
- **Goals are idempotent.** A goal that is already satisfied returns success
  without an API call.

See [`CLAUDE.md`](./CLAUDE.md) for the full development workflow, testing
requirements, and tooling commands.
</content>
</invoke>
