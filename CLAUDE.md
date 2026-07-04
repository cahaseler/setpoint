# setpoint

A long-running daemon that manages multiple SpaceMolt accounts, maintains live sessions, tracks game state, and exposes a declarative REST API for automation tools.

This file is working guidance for an AI agent (or human) developing **in this repository**. For user-facing docs see [README.md](README.md), [SETUP.md](SETUP.md), [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md).

## Project Overview

**What it does:** Connects to the SpaceMolt game over WebSocket v2 via `@spacemolt/lib` (Clerk-authenticated — one API key owns every account, no per-account passwords), mirrors each account's live game state into a local SQLite projection, and exposes a local HTTP API for declarative game automation.

**Declarative model:** Users specify desired states (e.g., "be at system X, docked, full fuel tank"), not individual API calls. setpoint plans and executes the steps. Built in layers:
1. **Primitives** — single-action declarative goals (travel, dock, refuel, buy, sell)
2. **Compound goals** — multi-step sequences built from primitives (travel + dock + refuel)
3. **Loops** — repeating behaviors (mine until full → sell → refuel → repeat)

**Multi-account:** Supports N accounts concurrently. Each account has its own lib connection, action queue, and state tracking.

## Tech Stack

| Tool | Purpose |
|------|---------|
| **Bun** | Runtime, bundler, test runner, package manager |
| **TypeScript** | Strict mode, all code |
| **Biome** | Linter + formatter (strict) |
| **bun:sqlite** | Local state persistence |
| **bun:test** | Testing (95% coverage target) |

## Project Structure

```
setpoint/
├── CLAUDE.md
├── README.md / SETUP.md / ARCHITECTURE.md / CONTRIBUTING.md / SECURITY.md
├── biome.json
├── bun.lock
├── package.json
├── tsconfig.json
├── scripts/
│   └── bump-version.ts             # Auto-increment patch version on deploy
├── packages/                       # Bun workspace packages
│   ├── protocol/                   # @setpoint/protocol — shared goal/loop/game-state types + zod schemas
│   └── client/                     # @setpoint/client — typed HTTP client for the daemon's API
├── src/
│   ├── index.ts                    # Entry point — starts the service
│   ├── accounts/                   # Multi-account management
│   │   ├── lib-manager.ts          # Account lifecycle via @spacemolt/lib's Clerk-based connectOwned
│   │   ├── lib-config.ts           # Parses config/dispatcher.json (clerkApiKey, accountsFilter)
│   │   └── config.ts               # Loads config/registration.json (registration_code)
│   ├── state/                      # Game state tracking (read-only SQLite projection of the lib cache)
│   │   ├── database.ts             # SQLite schema and queries
│   │   ├── store.ts                # State store interface
│   │   ├── projector.ts            # Writes lib-cache state changes into the SQLite store
│   │   └── attach-projector.ts     # Wires an account's onStateChange stream to the projector
│   ├── dispatcher/                 # Declarative goal engine (runs on @spacemolt/lib)
│   │   ├── goals.ts                # Shared goal result/status types (GoalResult, LoopResult, …)
│   │   ├── lib-goal-context.ts     # LibGoalContext + LibGoalAccount boundary; makeLibGoalContext
│   │   ├── lib-sequence.ts         # runLibSequence — compound step runner
│   │   ├── lib-loops.ts            # runLibLoop — loop execution engine
│   │   ├── state-freshness.ts      # Age-based refreshState escalation (STATE_FRESHNESS_TTL_MS)
│   │   ├── cargo.ts                # Cargo helpers
│   │   ├── lib-primitives/         # Single-action goals (travel, dock, refuel, …) on the lib
│   │   ├── lib-compounds/          # Multi-step goal sequences on the lib
│   │   └── lib-loops/              # Loop definitions (mining, trading, hauling, …) on the lib
│   ├── server/                     # Local HTTP API
│   │   ├── index.ts                # Server startup and route registration
│   │   ├── router.ts               # Route definitions and matching
│   │   ├── handlers.ts             # Request handlers
│   │   ├── goal-registry.ts        # Goal type registry for the API
│   │   └── loop-manager.ts         # Loop lifecycle management
│   ├── cli/                        # CLI client (smctl)
│   │   ├── index.ts                # Entry point
│   │   ├── commands.ts             # Command dispatch and help text
│   │   ├── client.ts               # HTTP client for daemon communication
│   │   └── output.ts               # Output formatting
│   └── util/                       # Shared utilities
│       ├── logger.ts
│       └── errors.ts
├── tests/                          # Mirrors src/ structure; packages/*/tests hold package-local tests
└── config/                         # Runtime config (gitignored)
    ├── dispatcher.json             # clerkApiKey + optional accountsFilter
    └── registration.json           # Shared registration code (used by the register endpoint)
```

## SpaceMolt v2 API Summary

`@spacemolt/lib` owns the entire wire protocol — setpoint never speaks raw WebSocket/REST to the game itself, only the lib's typed `Account`/`Commands` surface.

- **Transport:** `wss://game.spacemolt.com/ws/v2`, via `SpacemoltClient`/`Account` from `@spacemolt/lib`.
- **Auth:** a single Clerk API key drives every account you own (`new SpacemoltClient({ clerkApiKey })`). `connectOwned()` looks up and connects every account the key owns, minting a short-lived, single-use WS token per connection — no per-account passwords are stored anywhere.
- **Commands are queries or mutations**, classified from the server's OpenAPI spec:
  - **Queries** (`get_status`, `view_market`, …) resolve immediately, with no rate limit.
  - **Mutations** (`jump`, `mine`, `buy`, …) are queued for the next 10-second game tick, one per account per tick. The lib hides the two-phase protocol: an awaited mutation doesn't resolve until the action actually executes (which can be many ticks later for travel/jump), and the local state cache already reflects it by then. Mutations are serialized per account, and `rate_limited` responses are retried automatically underneath `account.commands`/`account.send()` — setpoint's own code never sees a game-level rate-limit error for a mutation.

### Rate Limits (game-side, per-IP)

These limits are enforced by the game server, not by setpoint — `@spacemolt/lib` paces connects and token minting internally so a large fleet won't trip them. setpoint does not implement its own connection stagger or rate limiter.

| Category | Limit | Notes |
|----------|-------|-------|
| WS connection cap | 100/min per IP | Checked at the HTTP upgrade, before credentials are read — can't be scoped per player. `connectAll`/`connectOwned` batch connects at `connectBatchSize` (default 100) with a `connectBatchWaitMs` pause (default 65s) between batches so a fleet of any size never actually asks for more than this in a window, plus a `connectStaggerMs` (default 250ms) delay between connects within a batch. |
| Token mint (Clerk `ws-token`) | Separate per-user budget | Doesn't compete with gameplay traffic. |
| `login_token` redemption | Rate limited per player, not per IP | A fleet connecting once each from one IP doesn't compete for a shared budget — only an individual account re-authenticating repeatedly gets throttled. |

For a fleet of N accounts, expect roughly `ceil(N / 100) - 1` waits of 65s plus `N * 250ms` of stagger — e.g. ~200 accounts connects in ~3 minutes, not the ~10 minutes a naive 10-20/min auth-rate model would suggest.

### Connection Lifecycle

`@spacemolt/lib` owns the WebSocket connection lifecycle end-to-end — setpoint does not implement session creation, keepalive, or reconnection-on-error itself:

- **Auto-reconnect + re-auth.** The lib reconnects on unexpected drops and re-authenticates, restoring subscriptions. Reconnect is close-code-aware: a `session_replaced` close (someone else logged in as that player) or a deliberate `close()` is terminal; transient drops retry with backoff.
- **Server restarts** drop every open WebSocket; the lib's reconnect-with-backoff handles this without setpoint needing to hammer rate limits.
- **`LibAccountManager`** (`src/accounts/lib-manager.ts`) is a thin layer on top: it calls `connectOwned()` at startup (or `connectOne()`/`register()` for a single account), indexes the returned accounts by `player_id`/username, and wires each account's `onStateChange` stream to the state projector. It does not manage reconnection itself — that stays inside the lib.

### Account Config Format

There are no more per-account credential files. The daemon is Clerk-based: on startup, `@spacemolt/lib`'s `connectOwned` looks up and connects every account owned by the configured Clerk API key (optionally narrowed by a filter), instead of reading one JSON file per account.

`config/dispatcher.json` (parsed by `parseLibConfig` in `src/accounts/lib-config.ts`):
```json
{
  "clerkApiKey": "ak_...",
  "accountsFilter": {
    "usernames": ["Player1"],
    "empires": ["solarian"],
    "includeHidden": false
  }
}
```
`clerkApiKey` is required (or set `SPACEMOLT_CLERK_API_KEY`, which takes precedence over the file). `accountsFilter` is optional — all clauses AND together; omit it to connect every owned, non-hidden account.

`config/registration.json` (parsed by `loadRegistrationConfig` in `src/accounts/config.ts`, still used by `POST /accounts/register`):
```json
{
  "registration_code": "code-from-spacemolt-dashboard"
}
```

Port and log level come from the `SM_PORT` and `SM_LOG_LEVEL` environment variables (defaults `7580` / `info`).

## Type Generation

All request and response types come from the `@spacemolt/lib` package. **Never hand-write API types.** There is no local OpenAPI codegen — the vendored spec and generated-types pipeline have been removed; types are updated by bumping the `@spacemolt/lib` dependency.

## State Management

`@spacemolt/lib` maintains a live, push-fed cache per account (`account.state`), seeded by `get_status` on connect and updated in real time from mutation deltas and server push events. That cache is the source of truth goals read from directly (via `LibGoalContext`) — no wire call needed.

The SQLite database is a **read-only mirror** of that cache, for the HTTP API's state endpoints (`GET /accounts/:playerId/state[/:section]`) to serve without going through an account's lib object. The `StateProjector` (`src/state/projector.ts`) writes it:
1. `LibAccountManager` wires each account's `onStateChange(sections)` stream (via `src/state/attach-projector.ts`) to the projector.
2. On each change, the projector reads the changed sections off `account.state` and calls `store.applyUpdate()`, which writes only the sections that are present (partial update — a `cargo`-only change doesn't clobber stored `ship`).

The local DB is as fresh as the last change the lib pushed to the account's cache. Goals and loops read `account.state` directly and never depend on the SQLite mirror; only the HTTP state endpoints do.

## Service HTTP API (localhost)

Starts on a configurable port (default: 7580), bound to `127.0.0.1`. It has **no authentication** and must stay on the loopback interface — see [SECURITY.md](SECURITY.md).

Endpoints expose:
- Account status and state queries (read from local SQLite)
- Declarative goal submission (travel to X, buy Y, etc.)
- Goal/loop status and cancellation
- Raw API passthrough (for operations not yet wrapped in goals)

## Commands

```bash
bun install              # Install dependencies
bun run build            # Type-check and bundle
bun run build:cli        # Compile the standalone smctl binary to dist/smctl
bun run start            # Start the setpoint daemon
bun run dev              # Start with watch mode
bun run smctl            # Run the CLI directly via bun (no compilation needed)
bun test                 # Run unit/integration tests
bun test --coverage      # Run tests with coverage report
bun run lint             # Biome check
bun run lint:fix         # Biome check + auto-fix
bun run format           # Biome format
bun run check            # Biome check + format
bun run deploy           # Full deploy: bump version, check, typecheck, test, build CLI
```

## Development Rules

### Code Style
- **Biome strict mode** — all recommended + strict rules enabled
- **TypeScript strict** — `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`
- Prefer `interface` over `type` for object shapes
- Use `unknown` over `any` — `any` should never appear in committed code
- All public functions must have explicit return types
- Use barrel exports (`index.ts`) per directory

### Testing
- **95% coverage target**
- Test files mirror source structure in `tests/`
- Fake the lib account surface (`FakeLibGoalAccount` / `tests/dispatcher/lib-fakes.ts`, `tests/accounts/fakes.ts`), never call the real `@spacemolt/lib` or game server in tests
- Test state transitions thoroughly — the state model is the core of the system

#### What must always have a test
Every piece of new behavior needs a test written at the same time as the code — not after:

- **Every CLI command** must have a test in `tests/cli/commands.test.ts` that verifies the exact URL and HTTP method it calls. This is the only way to catch URL mismatches between the CLI and the server router.
- **Every new server route** must have a test in `tests/server/handlers.test.ts` that verifies the handler is wired to the correct path.
- **Every new goal/primitive** must have a test covering: already-satisfied case, success case, failure/precondition-not-met case.
- **Every new option added to an existing goal** must have a test for the new behavior (e.g., adding `depositTarget: "faction"` requires a test that faction storage is called when set).

#### Before writing a CLI command that calls a server route
Read `src/server/index.ts` to verify the exact registered route path before using it in the CLI. Route names are not always obvious from the handler name — e.g., `handleDashboardData` is registered at `/dashboard/data`, not `/dashboard-data`.

### Error Handling
- Game API rejections surface as `SpacemoltError` (from `@spacemolt/lib`), with a `.code` field goals match against (e.g. `already_docked`, `unknown_destination`) — see `src/dispatcher/lib-primitives/dock-at.ts` for the pattern
- Connection/auth recovery (reconnect, re-auth, `rate_limited` retries) happens inside `@spacemolt/lib` — setpoint's own code doesn't implement 401/429 recovery for game calls
- Never swallow errors silently — log and surface them

### Git
- Conventional commits (`feat:`, `fix:`, `chore:`, `test:`, etc.)
- The pre-commit hook runs `bun run check` (Biome lint + format) — don't bypass it

### Deploy Workflow
After finishing a set of changes, run `bun run deploy`. It bumps the patch version (if there are uncommitted changes), runs lint + typecheck + tests, and compiles the standalone CLI binary (`dist/smctl`), then prints a summary block with the version and per-step status.

### Running the Daemon
- **Check if it's running:** `curl -s http://localhost:7580/health`
- **Free the port if needed:** `npx kill-port 7580` — avoid broad `pkill` that kills unrelated processes.

### Important Patterns
- **Never hardcode API types** — always use the types exported by `@spacemolt/lib`
- **The lib's push-fed cache is the source of truth** — the SQLite store is a read-only mirror of it (via `StateProjector`), kept current by wiring every account's `onStateChange` to the projector. No code path should read stale state by bypassing `account.state`.
- **Per-account isolation** — accounts must never share a lib connection, state, or queues
- **Respect rate limits proactively** — `@spacemolt/lib` already paces auth/connects and retries `rate_limited` mutations; don't add a second layer of pacing on top
- **Queue-based account connection** — `POST /accounts` (username of an account already owned by the configured Clerk API key) returns 202 Accepted and connects in the background; `@spacemolt/lib` batches and staggers the underlying connects to respect the 100/min per-IP WS-connection cap. Use `GET /accounts` to check connection status.
- **Account resolution by ID or username** — all API endpoints accepting a `playerId` parameter also accept a username (case-insensitive). Handlers use `resolveAccount()` to look up by player_id first, then by username.
- **Idempotent goals** — if a goal is already satisfied (e.g., already at the target location), it should succeed immediately without making API calls.

### Known Timing Behaviors
Key timing constants that interact — understand these before debugging any lock or retry issue:

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `DaemonClient.requestTimeoutMs` | 30s default; **no timeout (unbounded wait)** for sync goals, `raw`, `accounts register`, `accounts remove`, and forced `abort` | `src/cli/client.ts` (default), `GAME_API_TIMEOUT_MS` in `src/cli/commands.ts` (per-command override) | CLI per-request timeout |
| `retryDelayMs` | 1s | `src/cli/client.ts` | CLI delay between connection retries (3 attempts max) |

**Error handling**: The CLI distinguishes connection errors (daemon unreachable — retried 3 times) from timeouts (daemon running but slow — reported immediately, no retry). Timeouts produce exit code 5 (`"timeout"`); connection failures produce exit code 3 (`"connection_failed"`).

**Transit holds (game server behavior, hidden by `@spacemolt/lib`)**: a mutation like `jump` doesn't resolve until the ship *arrives* — the lib hides the two-phase mutation protocol, so the awaited call can take the full transit time (distance-based, can exceed 60s), not just one tick. A "slow" command (~1min wall clock, seconds of actual server processing) usually means it was queued behind a transit, not that anything is stuck. Queries always return instantly.

### Debugging Lock/Timing Issues
When debugging a "lock not releasing" report:

1. **Read the full execution chain first** — trace every file from the HTTP handler through to the game API call and back. Don't hypothesize from partial reading.
2. **Identify what happens AFTER the lock is acquired by the new request** — the release point may be correct, but a subsequent blocking operation (e.g., a mutation held by the lib for an in-progress transit) can hold the lock long enough for the CLI to time out and retry.
3. **Explain the anomalous timing** — if a failure takes 7 seconds but should be instant, there's a timeout+retry cycle involved. Work backwards from the timing to the matching timeout constant.
4. **Check both sides** — daemon-side locks AND client-side retry behavior. A bug can live in either place.

### Debugging Async Job Failures
Async job failures log at `[ERROR]` level:
```
[ERROR] [handlers] [accountId] Async job <jobId> (<goalType>) failed: <error message>
```
If an async job fails silently (a caller sees a failed job but there's no daemon log entry), that's a bug — error logging was missing from that code path.

### Transient API Errors in Goals
The game server occasionally returns errors for valid operations (e.g., "Unknown destination" for a valid POI). Primitives handle this differently:
- **`navigate-to-system`** — on jump failure, refreshes state and re-plans once from actual position
- **`go-to-poi`** — on `travel()` failure (ApiError or 5xx), refreshes state and retries once
- Loops handle failures at the iteration level (retry after 30s, up to 10 failures)
- Async goals do NOT auto-retry — the caller must handle retries

When an error looks like a transient game-server issue, read the code path first — missing retry/logging is often the real bug, not the transient error itself.

## Using smctl and the Daemon HTTP API

The `smctl` CLI and the daemon's HTTP API are the primary tools for testing, debugging, and operating setpoint. The CLI is a thin wrapper that translates commands into HTTP requests to the daemon.

### Running smctl

```bash
bun run smctl <command> [options]    # Run directly via bun (development)
dist/smctl <command> [options]       # Run the compiled standalone binary
```

### Global Flags

| Flag | Description |
|------|-------------|
| `--port <number>` | Daemon port (default: 7580, or `SM_PORT` env var) |
| `--json '<json>'` | Inline JSON body for POST commands |
| `--stdin` | Read JSON body from stdin (mutually exclusive with `--json`) |
| `--async` | Submit a goal in the background, return `job_id` immediately (`goal` command only) |
| `--version`, `-v` | Print smctl version |
| `--help`, `-h` | Print usage text |

### CLI Output Format

All smctl output is JSON on stdout (or stderr for connection/usage errors). Exit codes indicate result category:

| Code | Meaning |
|------|---------|
| 0 | Success (HTTP 2xx) |
| 1 | Client error (HTTP 4xx) |
| 2 | Server error (HTTP 5xx) |
| 3 | Daemon unreachable |
| 4 | Bad CLI arguments |

### Command Reference

#### Health and Status

```bash
smctl health                              # Check daemon health and uptime
smctl status                              # JSON dashboard data for all accounts
smctl log-level                           # Get current log level
smctl log-level debug                     # Set log level (debug|info|warn|error)
```

`smctl status` calls `GET /dashboard/data` and returns the raw JSON response. Each account entry includes: `player_id`, `username`, `state` (full game state), `loop` (loop status with `type`, `running`, `lastStep`), `hasRunningJob`, `hasExecutingGoal`, and `recentJobs` (5 most recent job records: `jobId`, `status`, `goalType`, `error`).

#### Account Management

```bash
smctl accounts list                       # List all connected + pending accounts
smctl accounts get <playerId>             # Get account details (accepts player_id or username)
smctl accounts add --json '{"username":"Player1"}'    # Connect an account already owned by the configured Clerk API key
smctl accounts register --json '{"username":"NewPlayer","empire":"solarian"}'
smctl accounts remove <playerId>          # Disconnect and remove account
```

Account addition is queue-based: `accounts add` returns 202 Accepted immediately and connects in the background (the lib staggers the underlying auth calls). Use `accounts list` or `accounts get` to check connection status.

Valid empires for registration: `solarian`, `voidborn`, `crimson`, `nebula`, `outerrim`.

#### Game State

```bash
smctl state <playerId>                    # Full game state for an account
smctl state <playerId> <section>          # player | ship | cargo | location | modules | skills | missions | queue
```

State is read from the local SQLite database (no API call). It is as fresh as the last mutation response.

#### Goals (One-off Actions)

Goals execute synchronously by default, blocking until complete.

```bash
# Synchronous goal (blocks until done, returns result)
smctl goal <playerId> --json '{"type":"navigate-to-system","options":{"targetSystemId":"sol"}}'

# Async goal (returns job_id immediately, poll for result)
smctl goal <playerId> --async --json '{"type":"navigate-to-system","options":{"targetSystemId":"sol"}}'
smctl job status <jobId>                  # Poll async goal status
```

Use `smctl help goals` for a complete list of goal types and their options.

**Use `--async` for any goal that takes more than ~4 minutes.** The sync (blocking) endpoint holds an open HTTP connection; Bun's server-level idle timeout closes connections after 255 seconds regardless of the per-request timeout setting. Goals still complete server-side, but smctl drops with `connection_failed` (exit code 3). The async endpoint returns a `job_id` in <1s and closes the connection immediately — no timeout risk. This applies to `fuel-rescue` routes of 20+ hops, long `navigate-to-system` chains, and any other multi-hop navigation.

A goal cannot be submitted while a loop is running on the same account (returns 409). Async goals also block if another async job is already running on the account.

#### Loops (Repeating Behaviors)

```bash
smctl loop status <playerId>              # Check loop status
smctl loop start <playerId> --json '{"type":"mining","options":{...}}'
smctl loop update <playerId> --json '{"junkItemIds":["rock_dust"]}'   # Patch options live
smctl loop stop <playerId>                # Stop a running loop
```

Supported loop types: `mining`, `enhanced-mining`, `salvage`, `roaming-salvage`, `tow-salvage`, `trading`, `hauling`, `storage-transfer`, `exploration`, `guard`.

Loop configs are persisted to disk and auto-resume on daemon restart.

Use `smctl help loops`, `smctl help trading`, or `smctl help hauling` for detailed schemas and examples.

#### Raw Command (Game API Passthrough)

The `raw` command posts directly to the daemon's `POST /accounts/:playerId/raw` endpoint, using the account's managed `@spacemolt/lib` connection — no external binary required.

```bash
smctl raw <playerId> <action> [args...]
smctl raw <playerId> get_state
smctl raw <playerId> travel sol_asteroid_belt
smctl raw <playerId> buy id=iron_ore quantity=10
```

**How it works:** the first arg after `playerId` is the `action` (posted with `toolGroup: "spacemolt"`). Remaining args are parsed as `key=value` pairs into `params` (numeric-looking values are coerced to numbers), or, if a single bare value is given with no `=`, it's sent as `params.id` — e.g. `travel sol_asteroid_belt` becomes `{"action":"travel","params":{"id":"sol_asteroid_belt"}}`. To reach a non-base tool group (e.g. `spacemolt_facility`), use the `POST /accounts/:playerId/raw` HTTP endpoint directly (see below) — `smctl raw` always targets the base `spacemolt` group.

### Help Commands

```bash
smctl help                                # General help with all commands
smctl help goals                          # All goal types and their options
smctl help loops                          # All loop types with example JSON
smctl help trading                        # Trading loop detailed reference
smctl help hauling                        # Hauling loop detailed reference
```

### Daemon HTTP API Reference

The daemon listens on `http://127.0.0.1:7580` by default. All responses are JSON. All endpoints accepting a `:playerId` parameter also accept a username (case-insensitive).

| Method | Path | Description | CLI Equivalent |
|--------|------|-------------|----------------|
| `GET` | `/health` | Daemon health + uptime | `smctl health` |
| `GET` | `/dashboard/data` | Dashboard JSON data | `smctl status` |
| `GET` | `/accounts` | List all accounts | `smctl accounts list` |
| `GET` | `/accounts/:playerId` | Account details | `smctl accounts get` |
| `POST` | `/accounts` | Add account (queued, 202) | `smctl accounts add` |
| `POST` | `/accounts/register` | Register new account | `smctl accounts register` |
| `DELETE` | `/accounts/:playerId` | Remove account | `smctl accounts remove` |
| `GET` | `/accounts/:playerId/state` | Full game state | `smctl state` |
| `GET` | `/accounts/:playerId/state/:section` | State section | `smctl state <id> <section>` |
| `POST` | `/accounts/:playerId/goal` | Execute goal (sync) | `smctl goal` |
| `POST` | `/accounts/:playerId/goal/async` | Execute goal (async, 202) | `smctl goal --async` |
| `GET` | `/jobs/:jobId` | Get async job status | `smctl job status` |
| `POST` | `/accounts/:playerId/loop` | Start loop (201) | `smctl loop start` |
| `GET` | `/accounts/:playerId/loop` | Get loop status | `smctl loop status` |
| `PATCH` | `/accounts/:playerId/loop` | Update loop options live (no restart) | `smctl loop update` |
| `DELETE` | `/accounts/:playerId/loop` | Stop loop | `smctl loop stop` |
| `DELETE` | `/accounts/:playerId/abort` | Release account from all in-progress work | `smctl abort` |
| `POST` | `/accounts/:playerId/raw` | Raw API passthrough | `smctl raw` |
| `GET` | `/accounts/:playerId/market/:baseId` | Cached order book for a base (subscribe first via `raw`) | `smctl market <id> <baseId>` |
| `GET` | `/accounts/:playerId/observation` | Cached observation-watch view (subscribe first via `raw`) | `smctl observation <id>` |
| `GET` | `/log-level` | Get log level | `smctl log-level` |
| `POST` | `/log-level` | Set log level | `smctl log-level <level>` |

#### Raw API Passthrough (HTTP)

`POST /accounts/:playerId/raw` makes direct game API calls through the daemon's managed `@spacemolt/lib` connection for the target account. Useful for curl-based testing and for AI assistants.

```bash
curl -s http://localhost:7580/accounts/Player1/raw \
  -H 'Content-Type: application/json' \
  -d '{"toolGroup":"spacemolt","action":"get_state"}'

curl -s http://localhost:7580/accounts/Player1/raw \
  -H 'Content-Type: application/json' \
  -d '{"toolGroup":"spacemolt","action":"travel","params":{"id":"sol"}}'

curl -s http://localhost:7580/accounts/Player1/raw \
  -H 'Content-Type: application/json' \
  -d '{"toolGroup":"spacemolt_facility","action":"list"}'
```

Request body fields:
- `toolGroup` (string, required) — the SpaceMolt API tool group. Most tool groups use a `spacemolt_X` prefix (e.g., `spacemolt_facility`, `spacemolt_market`, `spacemolt_ship`, `spacemolt_storage`). Short names without the prefix (e.g., `facility`, `market`) are also accepted and expanded automatically. Common actions like `get_state`, `travel`, `dock`, `mine` live in the base `spacemolt` group.
- `action` (string, required) — the action within the tool group (e.g., `get_state`, `travel`, `buy`)
- `params` (object, optional) — action parameters (e.g., `{"id":"...", "quantity":5}`)

The response contains `{ result, structuredContent }` (mutation responses also include `tick` and `command`). There is no `notifications` field — live push events (chat, combat, etc.) arrive on the account's event stream, not on command responses, so `raw` cannot relay them.
