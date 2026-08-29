# Architecture

This document explains how setpoint is built and why. It is intended for
contributors who want to understand the system before changing it. For usage and
the full API/CLI reference, see [`README.md`](./README.md).

## 1. Overview

setpoint is a long-running [Bun](https://bun.sh) + TypeScript daemon that
manages multiple SpaceMolt game accounts at once. It connects every account over
WebSocket v2 through `@spacemolt/lib` (Clerk-authenticated — one API key owns
every account), mirrors each account's live state cache into a local SQLite
database, and exposes a local HTTP API (and a thin CLI, `smctl`) for automation.

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

Every account is fully isolated: it has its own lib connection, its own state
rows, and at most one running loop. Accounts never share a connection, state, or
queues.

### Why these constraints shape the design

The SpaceMolt game server imposes a fact that drives most of the goal-engine
design:

- **Mutations are tick-bound.** The server executes at most one mutation per
  10-second game tick per account, and a mutation doesn't resolve until that
  tick actually runs (which can be many ticks later for travel/jump). Queries
  (`get_status`, `get_cargo`, `get_nearby`, …) are unlimited. This is why
  setpoint tracks a `ticksUsed` count on every goal result and prefers reading
  cached local state over re-querying.

Connection lifecycle — auth, reconnect, keepalive, rate-limit pacing for
connects and auth — is entirely `@spacemolt/lib`'s responsibility, not
setpoint's. `@spacemolt/lib` auto-reconnects and re-authenticates on unexpected
drops (a `session_replaced` close or a deliberate `close()` is terminal;
transient drops retry with backoff) and staggers connects to respect the
server's login rate limits. setpoint's `LibAccountManager` sits on top of this
and does not implement any of it itself (see §4).

## 2. The layered goal engine

The shared result/option types live in
[`src/dispatcher/goals.ts`](./src/dispatcher/goals.ts) (`GoalResult`,
`CompoundGoalResult`, `LoopResult`, `LoopOptions`, unchanged by the lib
migration). The goal contract itself is defined in
[`src/dispatcher/lib-goal-context.ts`](./src/dispatcher/lib-goal-context.ts):

```ts
interface LibGoal {
  readonly name: string;
  execute(ctx: LibGoalContext): Promise<GoalResult>;
}
```

A `GoalResult` reports `success`, a human-readable `message`, whether the goal was
`alreadySatisfied`, and `ticksUsed` (mutation actions consumed). The
`LibGoalContext` gives a goal everything it needs to act:

- `account` — the lib account: `account.state` (the live, push-fed state cache)
  and `account.commands` (the lib's full generated, typed command surface —
  `commands.spacemolt.dock()`, `commands.spacemolt_market.view_market(...)`, etc.).
- `state` — a live getter over `account.state`, never a stale snapshot.
- `refreshState(opts?)` — returns the push-fed cache for free unless the cache is
  stale (see `STATE_FRESHNESS_TTL_MS` in
  [`src/dispatcher/state-freshness.ts`](./src/dispatcher/state-freshness.ts)) or
  `{ force: true }` is passed, in which case it runs a live `account.refresh()`
  (a `get_status` re-seed). Primitives force a refresh where a mutation's delta is
  known to be incomplete (e.g. jumps carry no reliable position).
- `signal` — an `AbortSignal` for external cancellation.

The goal-naming convention follows the declarative model: goals are named for the
desired state, not the action taken — `navigate-to-system` rather than `jump`,
`ensure-fueled` rather than `refuel`. Implementation classes are prefixed `Lib`
(`LibNavigateToSystem`, `LibDockAt`, …) to distinguish them from types shared with
`@setpoint/protocol`.

### Primitives

Primitives live in
[`src/dispatcher/lib-primitives/`](./src/dispatcher/lib-primitives/).
Each is a single declarative goal that: (1) checks whether the desired state is
already satisfied, (2) validates prerequisites, (3) takes the minimal API action,
and (4) returns a result.

Example — [`navigate-to-system.ts`](./src/dispatcher/lib-primitives/navigate-to-system.ts):

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
`abandon-mission`), module goals (`install-mod`, `uninstall-mod`), the
faction-storage goals (`deposit-to-faction-storage`,
`load-from-faction-storage`, `ensure-credits-from-faction`, `gift-to-player`),
and salvage-related goals (`tow-wreck`, `dispose-towed-wreck`, `scan`).

### Compound goals

Compound goals live in
[`src/dispatcher/lib-compounds/`](./src/dispatcher/lib-compounds/). A compound
assembles primitives into a multi-step sequence and runs them in order via the
sequence runner
([`src/dispatcher/lib-sequence.ts`](./src/dispatcher/lib-sequence.ts):
`runLibSequence`), short-circuiting if any step fails. The result type
(`CompoundGoalResult`) carries the per-step results so callers can see exactly
which step ran and what it returned. Unlike the pre-migration sequence runner,
there is no wire refresh between steps — each mutation's delta lands on
`account.state` before the step's `await` resolves, so the next step reads
current state for free; a primitive forces a live refresh itself where a delta
is known to be incomplete.

Example — [`mining-run.ts`](./src/dispatcher/lib-compounds/mining-run.ts)
(`LibMiningRun`) composes:

1. `LibNavigateToSystem` — jump to the target system.
2. `LibGoToPoi` — travel to the asteroid belt.
3. `LibEnsureUndocked` — undock (can't mine while docked).
4. `LibMineUntilFull` — mine until cargo reaches the fullness threshold.

It refreshes state itself between the travel phase and the mining phase (a
compound-level choice, not something `runLibSequence` does automatically), and
reports the combined `ticksUsed` and whether all steps were already satisfied.
Other compounds include `prepare-at-station`, `sell-at-station`,
`buy-at-station`, `load-at-station`, `unload-at-station`,
`enhanced-mining-run`, `mine-with-jettison`, `fuel-rescue`, `loot-run`,
`loot-until-full`, and the towed-wreck compounds (`process-towed-wreck`,
`drain-towed-wreck`).

### Loops

Loops live in [`src/dispatcher/lib-loops/`](./src/dispatcher/lib-loops/) and are
driven by the generic loop engine in
[`src/dispatcher/lib-loops.ts`](./src/dispatcher/lib-loops.ts). `runLibLoop(factory,
ctx, options)` repeatedly:

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
failures. Unlike the pre-migration loop engine, `runLibLoop` never sees a
rate-limit error to special-case: `@spacemolt/lib` absorbs `rate_limited`
responses beneath the command layer and retries them against the server's
own pacing, so a thrown error reaching the loop is always a genuine failure paced
by `retryDelayMs`. Retry delays are abortable so a stop request takes effect
promptly. The engine keeps only the most recent 100 iteration results in memory.

Loop definitions (e.g. `mining-loop`, `enhanced-mining-loop`, `salvage-loop`,
`roaming-salvage-loop`, `tow-salvage-loop`, `trading-loop`, `hauling-loop`,
`storage-transfer-loop`, `exploration-loop`, `guard-loop`) supply the per-iteration
goal factory. The user-facing loop types and their option schemas are documented
in the README. Loop configs are persisted to disk (`config/loops/<player_id>.json`)
when a loop starts and auto-resume on daemon restart; the file is removed when the
loop stops or completes.

## 3. State model

`@spacemolt/lib` maintains the real state: a live, push-fed cache per account
(`account.state`), seeded by `get_status` on connect and updated in real time
from mutation deltas and server push events. Goals and loops read this cache
directly through `LibGoalContext` — no wire call, no SQLite involved.

The local SQLite database is a **read-only mirror** of that cache, kept
solely so the HTTP API's state endpoints
(`GET /accounts/:playerId/state[/:section]`) can serve state without going
through an account's live lib object.

### Storage

The schema ([`src/state/database.ts`](./src/state/database.ts)) is a single
`game_state` table keyed by `account_id`, with one JSON text column per state
section: `player`, `ship`, `cargo`, `location`, `modules`, `skills`, `missions`,
`queue`, plus `updated_at`. (The table also still has legacy `session_id` /
`session_expires_at` columns and store methods from the pre-migration
session-based system; nothing in the running daemon writes or reads them
anymore.) A separate `jobs` table tracks async goal jobs. WAL mode is enabled
for concurrent reads.

The store ([`src/state/store.ts`](./src/state/store.ts)) wraps the table.
`applyUpdate` performs **partial updates**: only sections that are present
(non-`undefined`, non-`null`) in an incoming state object are written, so an
update that only carries `cargo` does not clobber the stored `ship`.

### The projector flow

The flow that keeps the SQLite mirror current:

1. `LibAccountManager` (`src/accounts/lib-manager.ts`) wires each account's
   `onStateChange(sections)` stream — via
   `makeProjectingOnStateChange` in
   [`src/state/attach-projector.ts`](./src/state/attach-projector.ts) — to the
   projector, and backfills it once at connect time (the lib seeds state during
   `connect()` without firing `onStateChange`, so a freshly-connected account
   would otherwise read as unprojected).
2. `StateProjector.project()` ([`src/state/projector.ts`](./src/state/projector.ts))
   reads the changed sections off `account.state` and calls
   `store.applyUpdate()`.

Because the cache updates *before* a mutation's `await` resolves, a goal reading
`ctx.state` right after a mutation sees the new value with no extra round-trip.
The raw passthrough endpoint calls `account.send()` directly — its response also
flows through the same live cache, so the projected mirror stays current for
raw calls too.

## 4. Connection lifecycle

`@spacemolt/lib`'s `SpacemoltClient`/`Account` own the entire WebSocket
connection lifecycle — auth, reconnect, backoff, and rate-limit pacing for
connects and login are the lib's responsibility, not setpoint's.

- **Connect.** `SpacemoltClient({ clerkApiKey })` mints a short-lived, single-use
  WS token per account from the Clerk key and connects over
  `wss://game.spacemolt.com/ws/v2`. `connectOwned()` looks up and connects every
  account the key owns (optionally filtered), staggering connects internally so
  a large fleet doesn't trip the login rate limit.
- **Reconnect.** The lib auto-reconnects and re-authenticates on unexpected
  drops, restoring subscriptions. Reconnect is close-code-aware: a
  `session_replaced` close (someone else logged in as that player) or a
  deliberate `close()` is terminal; transient drops (e.g. a server restart)
  retry with backoff.
- **Rate-limited mutations.** `rate_limited` responses are retried automatically
  beneath `account.commands`/`account.send()`, honoring the server's pacing —
  setpoint's own code never sees this as an error to handle.

### `LibAccountManager`

`LibAccountManager` (`src/accounts/lib-manager.ts`) is a thin layer on top of the
lib client — it does not implement any connection-lifecycle logic itself:

- `connect()` calls `connectOwned()` with the configured filter, indexes the
  returned accounts by `player_id` and username, and wires each one's
  `onStateChange` to the state projector (see §3).
- `connectOne(idOrUsername)` connects a single stored account the same way, for
  `POST /accounts` (which returns 202 immediately and connects in the
  background — see `src/server/handlers.ts`'s `handleAddAccount`).
- `register(params)` registers a brand-new account and wires it identically.
- `listOwned()` lists the Clerk-owned players (connected or not), cached for 60s
  so a polling dashboard doesn't hit Clerk on every `GET /accounts`.
- `disconnect`/`remove` evict an account from both the lib client and the
  manager's own indexes, so the two can't diverge into a stale-closed-account
  leak.

Each account gets its own lib `Account` connection, keyed by `player_id` — there
is no shared connection, state, or queue between accounts.

## 5. HTTP API and CLI layering

The API access path is layered so each level has a single responsibility:

```
@spacemolt/lib (Account/Commands) → goals (LibGoalContext) → server handlers → Router
   (WS transport, auth, state cache)   (declarative)            (HTTP API)
```

- **`@spacemolt/lib`** — owns the WebSocket transport, Clerk auth, reconnect,
  and the live state cache (see §3, §4). setpoint treats it as a typed,
  self-managing client and never reimplements any of this.
- **Goals** — the declarative layer described in §2, which reads `account.state`
  and calls `account.commands`/`account.send()` directly.
- **Server handlers** ([`src/server/handlers.ts`](./src/server/handlers.ts)) —
  resolve the target account (`resolveAccount()`), translate HTTP requests into
  goal/loop/raw operations via `makeLibGoalContext`, and read state from the
  SQLite store for the state endpoints.
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
immediately); several commands that block on a game action (sync `goal`, `raw`,
`accounts register`, `accounts remove`, forced `abort`) disable the timeout
entirely rather than using the 30s default (`GAME_API_TIMEOUT_MS` in
`src/cli/commands.ts`). Because the CLI is a pure wrapper, every command
corresponds exactly to an HTTP route, and tests assert the URL/method each
command calls.

The `raw` passthrough (`POST /accounts/:playerId/raw`, and the `smctl raw`
command) calls `account.send()` directly for operations not yet wrapped in a
goal, normalizing the query/mutation response shapes into
`{ result, structuredContent }` (mutations also carry `tick`/`command`). Live
push events are not relayed here — they arrive on the account's event stream,
not on command responses.

## 6. Project structure

```
setpoint/
├── ARCHITECTURE.md                 # This document
├── README.md / SETUP.md / CONTRIBUTING.md / SECURITY.md
├── biome.json                      # Linter + formatter config
├── tsconfig.json                   # TypeScript (strict) config
├── package.json
├── scripts/
│   └── bump-version.ts             # Patch-version bump used by deploy
├── packages/                       # Bun workspace packages
│   ├── protocol/                   # @setpoint/protocol — shared goal/loop/game-state types + zod schemas
│   └── client/                     # @setpoint/client — typed HTTP client for the daemon's API
├── src/
│   ├── index.ts                    # Entry point — boot DB, projector, manager, server; connect accounts
│   ├── accounts/                   # Multi-account management
│   │   ├── lib-manager.ts          # Account lifecycle via @spacemolt/lib's Clerk-based connectOwned
│   │   ├── lib-config.ts           # Parses config/dispatcher.json (clerkApiKey, accountsFilter)
│   │   └── config.ts               # Loads config/registration.json (registration_code)
│   ├── state/                      # Game state tracking (read-only SQLite projection of the lib cache)
│   │   ├── database.ts             # SQLite schema (game_state + jobs)
│   │   ├── store.ts                # Per-account state store, partial updates
│   │   ├── projector.ts            # Writes lib-cache state changes into the SQLite store
│   │   └── attach-projector.ts     # Wires an account's onStateChange stream to the projector
│   ├── dispatcher/                 # Declarative goal engine (runs on @spacemolt/lib)
│   │   ├── goals.ts                # Shared goal result/status types (GoalResult, LoopResult, …)
│   │   ├── lib-goal-context.ts     # LibGoalContext + LibGoalAccount boundary; makeLibGoalContext
│   │   ├── lib-sequence.ts         # runLibSequence — compound step runner
│   │   ├── lib-loops.ts            # runLibLoop — loop execution engine
│   │   ├── state-freshness.ts      # Age-based refreshState escalation (STATE_FRESHNESS_TTL_MS)
│   │   ├── lib-primitives/         # Single-action goals (navigate, dock, refuel, buy, sell, …)
│   │   ├── lib-compounds/          # Multi-step goal sequences (mining-run, sell-at-station, …)
│   │   └── lib-loops/              # Loop definitions (mining, trading, hauling, …)
│   ├── server/                     # Local HTTP API
│   │   ├── index.ts                # Server startup and route registration
│   │   ├── router.ts               # Route matching
│   │   ├── handlers.ts             # Request handlers
│   │   ├── job-manager.ts          # Async job lifecycle (backed by the jobs table)
│   │   └── loop-manager.ts         # Loop lifecycle, persistence, and resume
│   ├── cli/                        # smctl CLI client
│   │   ├── index.ts                # Entry point
│   │   ├── commands.ts             # Command dispatch and help text
│   │   ├── client.ts               # HTTP client for daemon communication
│   │   └── output.ts               # Output formatting
│   └── util/                       # Shared utilities
│       ├── logger.ts               # Logging + token redaction
│       └── errors.ts               # Typed error classes
├── tests/                          # Mirrors src/ structure; packages/*/tests hold package-local tests
├── config/                         # Runtime config (gitignored): dispatcher.json, registration.json, loops/
└── data/                           # SQLite database (gitignored)
```

### Notable endpoints not mirrored by a single CLI command

Beyond the account/state/goal/loop endpoints documented in the README, the server
also exposes:

- `GET /dashboard/data` — aggregated JSON status for all accounts (loop status,
  running-job flags, recent jobs).
- `GET /accounts/:playerId/system` and
  `GET /accounts/:playerId/system/:systemId` — system data queried through a
  specific account's lib connection.
- `POST /accounts/:playerId/goal/async` and `GET /jobs/:jobId` — submit a goal as
  a background job and poll its result.
- `DELETE /accounts/:playerId/abort` — release an account from all in-progress
  work.

## 7. Key timing constants

These constants interact, and understanding them is essential before debugging any
lock, retry, or timeout issue.

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| Loop `retryDelayMs` | 30s | `src/dispatcher/lib-loops.ts` | Delay before retrying a failed loop iteration. `@spacemolt/lib` already retries `rate_limited` mutations beneath the command layer, so a `runLibLoop` retry only fires for a genuine goal failure, never a rate-limit response. |
| Loop `maxConsecutiveFailures` | 10 | `src/dispatcher/lib-loops.ts` | Consecutive iteration failures before a loop stops. |
| `DaemonClient.requestTimeoutMs` | 30s default; unbounded (no timeout) for sync goals, `raw`, `accounts register`, `accounts remove`, and forced `abort` | `src/cli/client.ts` (default), `GAME_API_TIMEOUT_MS` in `src/cli/commands.ts` (per-command override) | CLI per-request timeout. |
| Server `idleTimeout` | 255s | `src/server/index.ts` | Bun server-level idle timeout; long goals must use the async endpoint. |

A "slow" mutation response (≈1 minute wall clock) is usually a command queued
behind a ship in transit — `@spacemolt/lib` hides the two-phase mutation
protocol, so an awaited `jump` doesn't resolve until the ship actually arrives,
which can be the full distance-based transit time. Queries always return
instantly. When a failure takes several seconds that should have been instant, a
timeout-plus-retry cycle is involved; work backwards from the timing to identify
which constant matches.

## Conventions for contributors

- **Types are never hand-written.** All request/response types come from the
  `@spacemolt/lib` package — there is no local type generation. Update types by
  bumping the `@spacemolt/lib` dependency.
- **The lib's push-fed cache is the source of truth.** The SQLite store is a
  read-only mirror of it, kept current by wiring every account's
  `onStateChange` to the `StateProjector`. No code path should read stale state
  by bypassing `account.state`.
- **Per-account isolation is invariant.** Connections, state, and queues must
  never be shared across accounts.
- **Respect rate limits proactively.** `@spacemolt/lib` already paces
  auth/connects and retries `rate_limited` mutations; don't add a second layer
  of pacing on top of it.
- **Goals are idempotent.** A goal that is already satisfied returns success
  without an API call.

See [`CLAUDE.md`](./CLAUDE.md) for the full development workflow, testing
requirements, and tooling commands.
</content>
</invoke>
