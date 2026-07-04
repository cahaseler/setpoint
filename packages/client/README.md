# @setpoint/client

Typed HTTP client for the setpoint daemon's local REST API. Wraps every route
in `src/server/handlers.ts` behind a small typed surface, so a consumer gets
`GoalType`/`GoalOptionsMap`/`LoopType`/`LoopOptionsMap` etc. autocomplete
instead of hand-building request bodies and guessing at response shapes.

This package is a Bun workspace member (`packages/client`), consumed today via
`workspace:*` from inside this repo (e.g. `src/cli` does not use it — it's for
external Node/Bun consumers). It is **not published to npm** — there is no
`publishConfig`/registry set up.

For a consumer in a sibling directory on the same machine (e.g. ILC), a plain
`file:` dependency on `packages/client` does **not** work — its own
`package.json` depends on `@setpoint/protocol` via `workspace:*`, which Bun can
only resolve when the installer is itself inside the setpoint workspace; a
`file:` install from outside fails with `Workspace dependency "@setpoint/protocol"
not found` (verified). `bun link` does work and has been verified end-to-end:

```bash
# once, inside this repo
cd packages/protocol && bun link
cd ../client && bun link

# in the consuming repo
bun link @setpoint/protocol
bun link @setpoint/client
```

This registers both packages as symlinks back into this repo, so local edits
here are picked up immediately without reinstalling. It's a local-dev
workaround, not a real distribution story — decide with Craig whether this repo
should get a proper publish step (or `file:`-based internal deps instead of
`workspace:*`) before ILC builds anything long-term on top of it.

## Install / reference

```jsonc
// from inside this repo's workspace
"dependencies": { "@setpoint/client": "workspace:*" }
```

## Quick start

```ts
import { SetpointClient } from "@setpoint/client";

const sp = new SetpointClient({ baseUrl: "http://127.0.0.1:7580" }); // default shown

const health = await sp.health(); // { status, uptime, startedAt, accounts }
const { accounts } = await sp.accounts.list();
```

`baseUrl` defaults to `http://127.0.0.1:7580`. Other constructor options:
`timeoutMs` (per-request abort timeout; unset/0 disables it) and
`retryDelayMs` (delay between the 3 built-in retries of a connection failure —
see **Errors** below for what does and doesn't retry).

Every account-scoped call takes a `player_id` **or** username (case-insensitive)
— same as the HTTP API and `smctl`.

## Top-level client (`sp`)

| Call | Daemon route | Notes |
|---|---|---|
| `sp.health()` | `GET /health` | |
| `sp.dashboard()` | `GET /dashboard/data` | Full state + loop + job info for every account |
| `sp.logLevel()` / `sp.logLevel(level)` | `GET`/`POST /log-level` | `level` is `"debug"\|"info"\|"warn"\|"error"` |
| `sp.accounts` | — | `AccountsApi`, see below |
| `sp.account(id)` | — | `AccountApi` scoped to one account, see below |
| `sp.job(jobId)` | — | `JobApi` for a job id you already have, see below |

## Accounts collection (`sp.accounts`)

| Call | Daemon route |
|---|---|
| `sp.accounts.list()` | `GET /accounts` — connected + pending accounts |
| `sp.accounts.get(id)` | `GET /accounts/:id` — 404s (`SetpointHttpError`) if unresolved |
| `sp.accounts.add(username)` | `POST /accounts` — 202, connects in the background |
| `sp.accounts.register({ username, empire })` | `POST /accounts/register` |
| `sp.accounts.remove(id)` | `DELETE /accounts/:id` |

`empire` is one of `"solarian" \| "voidborn" \| "crimson" \| "nebula" \| "outerrim"`.

## Account-scoped API (`sp.account(id)`)

### Goals

```ts
const account = sp.account("Player1"); // or a player_id

// Blocks until the goal completes. Throws GoalFailedError on failure.
const result = await account.goal("navigate-to-system", { targetSystemId: "sol" });

// Returns immediately with a job id; poll or wait separately.
const { job_id } = await account.goalAsync("navigate-to-system", { targetSystemId: "sol" });

// Async submit + poll-to-completion in one call. Throws on failure.
const result2 = await account.runToCompletion("dock-at", { targetBaseId: "sol_station" });
```

- `goal()` has no timeout (sync goals can run for minutes) and throws
  `GoalFailedError` if the goal fails during execution (the daemon streams
  `{error}` over an HTTP 200 for this case — the client detects and rethrows).
- `goalAsync()` / `runToCompletion()` mirror `smctl goal --async` + `job status`.
  Use these for anything that could run past ~4 minutes — see the "Use
  `--async` for any goal that takes more than ~4 minutes" note in the top-level
  `CLAUDE.md` (Bun's idle-connection timeout, not a client limitation).
- `GoalType`/`GoalOptionsMap` are re-exported from `@setpoint/protocol` — the
  canonical list of goal types and their options lives in
  `packages/protocol/src/goals.ts` (or run `smctl help goals`).

### Loops (`account.loop`)

| Call | Daemon route |
|---|---|
| `account.loop.start(type, options)` | `POST /accounts/:id/loop` |
| `account.loop.get()` | `GET /accounts/:id/loop` — `{running: false}` if never run |
| `account.loop.patch(partial)` | `PATCH /accounts/:id/loop` — **flat** partial, not `{options}` |
| `account.loop.stop()` | `DELETE /accounts/:id/loop` |

`LoopType`/`LoopOptionsMap` are re-exported from `@setpoint/protocol` — see
`packages/protocol/src/loops.ts` or `smctl help loops` for the full list
(`mining`, `enhanced-mining`, `salvage`, `roaming-salvage`, `tow-salvage`,
`trading`, `hauling`, `storage-transfer`, `exploration`, `guard`).

### State (`account.state`)

| Call | Daemon route |
|---|---|
| `account.state.get()` | `GET /accounts/:id/state` — full `V2GameState` |
| `account.state.section(name)` | `GET /accounts/:id/state/:section` (e.g. `"ship"`, `"cargo"`, `"location"`) |
| `account.state.refresh()` | `POST /accounts/:id/state/refresh` — forces a live `get_state` call |

State reads are served from setpoint's local SQLite mirror (no wire call) except `refresh()`.

### System/POI map (`account.system`)

`account.system.get(systemId?)` → `GET /accounts/:id/system[/:systemId]`. With
no argument, returns the account's current system.

### Live market (`account.market`) and observation (`account.observation`)

The lib maintains push-fed caches of a subscribed station's order book and a
subscribed observation watch (nearby/system player presence), but neither is
part of the 8-section state model above — there's no subscribe call here.
Subscribe first via the raw passthrough, then read:

```ts
await account.raw.spacemolt_market.subscribe_market(); // subscribes to the station you're docked at
const book = await account.market.get("sol_station");   // { base_id, base_name?, tick, items: MarketItem[] }

await account.raw.spacemolt.subscribe_observation();     // or { active_scan: true }
const view = await account.observation.get();             // { poi_id?, system_id?, tick, nearby, system, cloaked, unknownSignature, activeScan }
```

Both `get()` calls throw `SetpointHttpError` (404) if you haven't subscribed
yet, or haven't received the first push update since subscribing — the daemon
reads the lib's cache directly (no SQLite mirror, no polling), so there's a
brief window after a bare `subscribe_market`/`subscribe_observation` call
before data appears.

| Call | Daemon route |
|---|---|
| `account.market.get(baseId)` | `GET /accounts/:id/market/:baseId` |
| `account.observation.get()` | `GET /accounts/:id/observation` |

### Raw passthrough (`account.raw`)

```ts
await account.raw.spacemolt.travel({ id: "sol_asteroid_belt" });
await account.raw.spacemolt.undock(); // zero-arg actions work too
await account.raw.spacemolt_facility.list();
```

`account.raw.<group>.<action>(params)` is a typed proxy over `@spacemolt/lib`'s
generated `Commands` — the param types for every group/action come straight
from the lib, so this stays in sync with the game's command catalog
automatically. Each call POSTs `/accounts/:id/raw` and returns the daemon's
`RawEnvelope` (`{ result, structuredContent }`, plus `tick`/`command` for
mutations) — not the lib's own WS result type.

### Abort

`account.abort({ force? })` → `DELETE /accounts/:id/abort` — releases the
account from any in-progress loop/sync-goal/async-job. `force: true` fires
abort signals and cleans up immediately instead of just reporting status.

## Direct job lookup (`sp.job(jobId)`)

For a job id obtained outside `runToCompletion` (e.g. from `goalAsync`):

```ts
const job = sp.job(jobId);
await job.get();                                   // current record, any status
await job.wait({ pollMs: 2000, timeoutMs: 60_000 }); // poll to terminal status; does NOT throw on failure
```

## Errors

All thrown errors are typed classes exported from `@setpoint/client`:

| Class | When |
|---|---|
| `SetpointHttpError` | Any non-2xx response (other than 410). Has `.status` and `.body`. |
| `DeprecatedGoalError` | HTTP 410 — the endpoint/goal has been removed. |
| `GoalFailedError` | `account.goal()`'s sync goal failed during execution. |
| `ConnectionError` | Daemon unreachable after 3 retries (`retryDelayMs` apart). |
| `TimeoutError` | Daemon reachable but didn't respond within `timeoutMs`. Never retried. |

Connection failures retry automatically (3 attempts); timeouts do not — a slow
daemon and a dead daemon fail differently and are reported as such.

## Re-exported protocol types

`@setpoint/client` re-exports everything from `@setpoint/protocol`
(`GoalResult`, `LoopStatus`, `JobRecord`, `RawEnvelope`, `V2GameState`,
`GoalType`/`GoalOptionsMap`, `LoopType`/`LoopOptionsMap`, `Empire`,
`MarketBookSnapshot`, `ObservationSnapshot`, `MarketItem`, `ObservedPlayer`,
`CloakedContact`, etc.), so a consumer only needs the one dependency.

## Full example

```ts
import { SetpointClient, GoalFailedError } from "@setpoint/client";

const sp = new SetpointClient();

const { accounts } = await sp.accounts.list();
console.log(`${accounts.length} accounts known`);

const player = sp.account("Player1");

try {
  await player.goal("navigate-to-system", { targetSystemId: "sol" });
} catch (err) {
  if (err instanceof GoalFailedError) {
    console.error("goal failed:", err.message);
  } else {
    throw err;
  }
}

await player.loop.start("mining", {
  miningSystemId: "sol",
  beltPoiId: "sol_asteroid_belt",
  sellSystemId: "sol",
  sellStationPoiId: "sol_station",
  sellBaseId: "sol_market",
});
const status = await player.loop.get();
console.log(status);
```
