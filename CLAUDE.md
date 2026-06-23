# setpoint

A long-running daemon that manages multiple SpaceMolt accounts, maintains live sessions, tracks game state, and exposes a declarative REST API for automation tools.

This file is working guidance for an AI agent (or human) developing **in this repository**. For user-facing docs see [README.md](README.md), [SETUP.md](SETUP.md), [ARCHITECTURE.md](ARCHITECTURE.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [SECURITY.md](SECURITY.md).

## Project Overview

**What it does:** Connects to the SpaceMolt v2 REST API (`game.spacemolt.com/api/v2/`), manages session lifecycle for multiple game accounts, maintains an accurate local game state model in SQLite, and exposes a local HTTP API for declarative game automation.

**Declarative model:** Users specify desired states (e.g., "be at system X, docked, full fuel tank"), not individual API calls. setpoint plans and executes the steps. Built in layers:
1. **Primitives** — single-action declarative goals (travel, dock, refuel, buy, sell)
2. **Compound goals** — multi-step sequences built from primitives (travel + dock + refuel)
3. **Loops** — repeating behaviors (mine until full → sell → refuel → repeat)

**Multi-account:** Supports N accounts concurrently. Each account has its own session, action queue, and state tracking.

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
│   ├── bump-version.ts             # Auto-increment patch version on deploy
│   └── generate-types.ts           # Generate API types from the OpenAPI spec
├── src/
│   ├── index.ts                    # Entry point — starts the service
│   ├── generated/                  # Auto-generated from the OpenAPI spec (DO NOT EDIT)
│   │   └── api-types.ts
│   ├── api/                        # SpaceMolt API client layer
│   │   ├── client.ts               # HTTP client, request/response handling
│   │   ├── session.ts              # Session creation, keepalive, recovery
│   │   └── endpoints.ts            # Typed endpoint wrappers
│   ├── accounts/                   # Multi-account management
│   │   ├── manager.ts              # Account lifecycle, connection queue, config loading
│   │   └── config.ts               # Config file schema, loading, and credential parsing
│   ├── state/                      # Game state tracking
│   │   ├── database.ts             # SQLite schema and queries
│   │   ├── store.ts                # State store interface
│   │   └── updater.ts              # Applies mutation responses to state
│   ├── dispatcher/                 # Declarative goal engine
│   │   ├── goals.ts                # Goal interface and types
│   │   ├── sequence.ts             # Sequential goal execution
│   │   ├── sequence-goal.ts        # Sequence goal wrapper
│   │   ├── loops.ts                # Loop execution engine
│   │   ├── primitives/             # Single-action goals (travel, dock, refuel, etc.)
│   │   ├── compounds/              # Multi-step goal sequences
│   │   └── loops/                  # Loop definitions (mining, trading, hauling, …)
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
├── tests/                          # Mirrors src/ structure
└── config/                         # Runtime config (gitignored — holds credentials)
    ├── registration.json           # Shared registration code
    └── accounts/                   # One JSON file per account
```

## SpaceMolt v2 API Summary

- **Base URL:** `https://game.spacemolt.com/api/v2/`
- **Auth flow:** `POST /session` → get session ID → include as `X-Session-Id` header on all calls
- **Request pattern:** `POST /api/v2/{tool_group}/{action}` with JSON body (`id`, `quantity`, `text` fields)
- **Response envelope:** `{ result, structuredContent, notifications, session, error }`
  - `structuredContent` always contains typed JSON data for programmatic use
  - `session` contains `{ id, player_id, created_at, expires_at }`
  - `notifications` accumulates events since last request
- **Mutations are synchronous:** The server blocks until the game tick executes, then returns the result. One mutation per 10-second tick per account.
- **Queries are unlimited:** `get_state`, `get_cargo`, `get_nearby`, etc. have no rate limit.

### Rate Limits (per-IP, 1-minute fixed window)

| Category | Limit | Notes |
|----------|-------|-------|
| Session creation | 20/min | Separate counter from auth |
| Auth (login/register) | 10/min | Total attempts |
| Failed auth | 5/min | Blocks ALL auth on failure threshold |

### Session Lifecycle

- **Inactivity timeout:** 30 minutes — every request bumps `LastSeen`
- **No persistence:** Sessions are in-memory on the game server. Server restarts kill all sessions.
- **Server restarts regularly** due to the update cycle — must handle session loss gracefully without hammering rate limits.

**Session keepalive strategy:**
- Poll a cheap query endpoint at regular intervals (every 10–15 minutes) to prevent timeout
- On 401 response, re-create session + re-login, respecting rate limits
- On startup with N accounts, stagger session creation to stay under 20/min
- Track session health per-account independently

### Account Config Format

`config/registration.json`:
```json
{
  "registration_code": "code-from-spacemolt-dashboard"
}
```

`config/accounts/<name>.json` (matches the API registration response format):
```json
{
  "username": "Player1",
  "password": "generated-password",
  "player_id": "uuid"
}
```

Port and log level come from the `SM_PORT` and `SM_LOG_LEVEL` environment variables (defaults `7580` / `info`); there is no `dispatcher.json`.

## Type Generation

All request and response types are generated from the SpaceMolt OpenAPI spec. **Never hand-write API types.**

- `bun run generate` produces `src/generated/api-types.ts` via `openapi-typescript`.
- The spec is read from a vendored `openapi/spacemolt-v2.json` if present, and otherwise fetched from the live endpoint (`game.spacemolt.com/api/v2/openapi.json`). This public distribution does not vendor the spec.
- The generated file is committed, so a normal build needs no network — only regenerating types does.
- Generated files are never edited by hand.

## State Management

Every mutation response's `structuredContent` contains a `V2GameState` with partial updates to: `player`, `ship`, `cargo`, `location`, `modules`, `skills`, `missions`, `queue`.

The state updater:
1. Receives every API response
2. Extracts `structuredContent` fields
3. Merges them into the per-account SQLite state
4. Emits state change events (for the goal engine to react to)

The local DB is always as fresh as the last API response. Queries can read local state without hitting the API.

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
bun run generate         # Regenerate types from the OpenAPI spec
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
- Mock the HTTP layer, never call the real SpaceMolt API in tests
- Use fixture files for API response data
- Test state transitions thoroughly — the state model is the core of the system
- Test rate-limit compliance — verify staggered session creation, keepalive timing
- Test session recovery — simulate 401s, server restarts

#### What must always have a test
Every piece of new behavior needs a test written at the same time as the code — not after:

- **Every CLI command** must have a test in `tests/cli/commands.test.ts` that verifies the exact URL and HTTP method it calls. This is the only way to catch URL mismatches between the CLI and the server router.
- **Every new server route** must have a test in `tests/server/handlers.test.ts` that verifies the handler is wired to the correct path.
- **Every new goal/primitive** must have a test covering: already-satisfied case, success case, failure/precondition-not-met case.
- **Every new option added to an existing goal** must have a test for the new behavior (e.g., adding `depositTarget: "faction"` requires a test that faction storage is called when set).

#### Before writing a CLI command that calls a server route
Read `src/server/index.ts` to verify the exact registered route path before using it in the CLI. Route names are not always obvious from the handler name — e.g., `handleDashboardData` is registered at `/dashboard/data`, not `/dashboard-data`.

### Error Handling
- All API errors must be typed (use the `V2Response.error` structure)
- Session errors (401) trigger automatic recovery, not user-facing errors
- Rate-limit errors (429) include `retry_after` — respect it, add jitter
- Never swallow errors silently — log and surface them

### Git
- Conventional commits (`feat:`, `fix:`, `chore:`, `test:`, etc.)
- The pre-commit hook runs `bun run check` (Biome lint + format) — don't bypass it
- Don't commit generated code changes without regenerating from the spec

### Deploy Workflow
After finishing a set of changes, run `bun run deploy`. It bumps the patch version (if there are uncommitted changes), runs lint + typecheck + tests, and compiles the standalone CLI binary (`dist/smctl`), then prints a summary block with the version and per-step status.

### Running the Daemon
- **Check if it's running:** `curl -s http://localhost:7580/health`
- **Free the port if needed:** `npx kill-port 7580` — avoid broad `pkill` that kills unrelated processes.

### Important Patterns
- **Never hardcode API types** — always use generated types from the OpenAPI spec
- **Every mutation response updates state** — no mutation call should skip the state updater
- **Per-account isolation** — accounts must never share sessions, state, or queues
- **Respect rate limits proactively** — don't rely on 429 responses to pace; predict and prevent
- **Queue-based account connection** — `POST /accounts` returns 202 Accepted and queues accounts for background connection with a ~6.5s stagger (10 auth/min rate limit). Use `GET /accounts` to check connection status.
- **Account resolution by ID or username** — all API endpoints accepting a `playerId` parameter also accept a username (case-insensitive). Handlers use `resolveAccount()` to look up by player_id first, then by username.
- **Idempotent goals** — if a goal is already satisfied (e.g., already at the target location), it should succeed immediately without making API calls.

### Known Timing Behaviors
Key timing constants that interact — understand these before debugging any lock or retry issue:

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `ACTION_IN_PROGRESS_WAIT_MS` | 12s | `src/api/session.ts` | Wait before retrying when the game server has a pending action |
| `DaemonClient.requestTimeoutMs` | 30s default, **5min for sync goals** | `src/cli/client.ts` | CLI per-request timeout |
| `SpaceMoltClient.requestTimeoutMs` | 5min | `src/api/client.ts` | HTTP timeout to the game server |
| `retryDelayMs` | 1s | `src/cli/client.ts` | CLI delay between connection retries (3 attempts max) |

**Error handling**: The CLI distinguishes connection errors (daemon unreachable — retried 3 times) from timeouts (daemon running but slow — reported immediately, no retry). Timeouts produce exit code 5 (`"timeout"`); connection failures produce exit code 3 (`"connection_failed"`).

**Transit holds (game server behavior)**: `jump` blocks until the ship *arrives* — the HTTP response is held for the full transit (distance-based, can exceed 60s), not just one tick. A mutation submitted while a ship is in transit is also held server-side until arrival, then validated/executed — so a "slow" command answer (~1min wall clock, seconds of server processing) usually means it was queued behind a transit, not that anything is stuck. Queries return instantly. Further mutations beyond the held one can be rejected with `code: in_transit` (the session layer polls through that like `action_in_progress`).

### Debugging Lock/Timing Issues
When debugging a "lock not releasing" report:

1. **Read the full execution chain first** — trace every file from the HTTP handler through to the game API call and back. Don't hypothesize from partial reading.
2. **Identify what happens AFTER the lock is acquired by the new request** — the release point may be correct, but a subsequent blocking operation (e.g., an `action_in_progress` retry) can hold the lock long enough for the CLI to time out and retry.
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
| `--output-json` | Pass `--json` to the spacemolt CLI for JSON output (`raw` command only) |
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
smctl accounts add --json '{"username":"Player1","password":"pass","player_id":"uuid"}'
smctl accounts add --json '{"username":"Player1","password":"pass"}'    # Credentials-only (discovers player_id via login)
smctl accounts register --json '{"username":"NewPlayer","empire":"solarian"}'
smctl accounts remove <playerId>          # Disconnect and remove account
```

Account addition is queue-based: `accounts add` returns 202 Accepted immediately and connects in the background with stagger delays. Use `accounts list` or `accounts get` to check connection status.

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

Supported loop types: `mining`, `enhanced-mining`, `trading`, `hauling`, `storage-transfer`.

Loop configs are persisted to disk and auto-resume on daemon restart.

Use `smctl help loops`, `smctl help trading`, or `smctl help hauling` for detailed schemas and examples.

#### Raw Command (spacemolt CLI Passthrough)

The `raw` command spawns the external `spacemolt` CLI binary with the account's managed session token, allowing arbitrary game API calls without managing sessions manually. (The `spacemolt` binary is a separate third-party tool you obtain yourself — see [SETUP.md](SETUP.md).)

```bash
smctl raw <playerId> <command> [args...]
smctl raw <playerId> get_state
smctl raw <playerId> travel sol_asteroid_belt
smctl raw <playerId> buy id=iron_ore quantity=10
smctl raw <playerId> get_nearby --output-json    # Pass --json to the spacemolt CLI
```

**How it works:** smctl fetches the session token from `GET /accounts/:playerId/session`, then spawns the spacemolt CLI binary with `--session <token>` prepended to the command arguments. The CLI process inherits stdio, so its output goes directly to the terminal.

**Binary resolution order:**
1. `SPACEMOLT_CLI` environment variable (path to the binary)
2. `spacemolt` binary in the same directory as smctl (or one level up, for the `dist/` layout)
3. `spacemolt` on the system `PATH`

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
| `GET` | `/accounts/:playerId/session` | Get session token | (used by `smctl raw`) |
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
| `POST` | `/accounts/:playerId/raw` | Raw API passthrough | -- |
| `GET` | `/log-level` | Get log level | `smctl log-level` |
| `POST` | `/log-level` | Set log level | `smctl log-level <level>` |

#### Raw API Passthrough (HTTP)

`POST /accounts/:playerId/raw` makes direct game API calls through the daemon's managed session, without the external spacemolt CLI binary. Useful for curl-based testing and for AI assistants.

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

The response contains `{ result, structuredContent, notifications }` directly from the game API.
