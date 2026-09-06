# setpoint

**setpoint is a declarative control plane for your SpaceMolt fleet.** Tell it the outcome you want — *"be docked and fully fueled at Trader's Rest"*, *"mine this belt until the hold is full, then sell"*, *"run this buy-low / sell-high trade loop"* — and it works out the steps and carries them out. You describe **what**; setpoint figures out **how**.

It's built for players who automate. SpaceMolt rewards multi-account play and scripted routines, but most of that work isn't strategy — it's plumbing: logging a dozen accounts in, keeping sessions alive across the server's frequent restarts, pacing one mutation per ten-second tick, staying under the rate limits, and tracking every ship's state. setpoint owns all of it. It runs as a local daemon that holds your accounts' sessions, keeps a live SQLite model of every ship, and exposes the whole fleet through a small local HTTP API and a CLI (`smctl`).

That makes it a **substrate for your own tools.** Point a script, an LLM agent, or a fleet-brain at setpoint and let it reason in goals and loops — *"make this account do X"* — instead of reimplementing session management, rate-limit accounting, and tick timing. Your tools decide what to do; setpoint handles how to do it, reliably, across the whole fleet.

> **Unofficial third-party tool.** This is a community automation client for SpaceMolt, not an official product of the game's operators. Run it with your own accounts at your own discretion.

## Quick Start

```bash
bun install
# Configure config/dispatcher.json: { "clerkApiKey": "ak_..." }
# All accounts owned by that Clerk API key connect automatically.
bun run start            # Start daemon (default port 7580, localhost only)
bun run smctl health     # Verify daemon is running
```

For full installation and configuration, see **[SETUP.md](SETUP.md)**.

## Documentation

- **[SETUP.md](SETUP.md)** — installation and first-run guide
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the daemon is structured
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — development workflow and conventions
- **[SECURITY.md](SECURITY.md)** — trust model and vulnerability reporting

## Programmatic Access

Two published workspace packages let you drive setpoint from your own TypeScript
without hand-rolling HTTP:

- **`@setpoint/client`** — a typed client for the whole daemon API. Goal and loop
  options are typed from the schema registry, so your editor knows the options
  for every goal type.
- **`@setpoint/protocol`** — the shared goal/loop/result types and zod schemas.
  Anything crossing the daemon/client boundary is defined here once.

```ts
import { SetpointClient } from "@setpoint/client";

const sp = new SetpointClient({ baseUrl: "http://localhost:7580" });

await sp.account("MyPilot").goal("navigate-to-system", { targetSystemId: "sol" });
await sp.account("MyPilot").loop.start("mining", { /* typed options */ });

// One goal across many accounts, in one round trip, keyed by player id.
const batch = await sp.batchGoal(["PilotA", "PilotB"], "ensure-magazines", {});

// Live streams, as async iterables over Server-Sent Events
for await (const event of sp.account("MyPilot").crafting.events()) {
  console.log(event);
}
```

## CLI Reference

All commands are available via `smctl`. `--port <n>`, `--json '<json>'` and
`--stdin` apply globally; `--async` applies to `goal`.

| Command | Description |
|---------|-------------|
| `smctl health` | Daemon health and uptime |
| `smctl status` | Dashboard JSON for every account (state, loop, jobs) |
| `smctl accounts list` | List connected and pending accounts |
| `smctl accounts get <id>` | Account details |
| `smctl accounts add --json '{...}'` | Connect an account the Clerk key already owns |
| `smctl accounts register --json '{...}'` | Register a new account |
| `smctl accounts remove <id>` | Disconnect and remove an account |
| `smctl state <id> [section]` | Game state, or one section |
| `smctl goal <id> [--async] --json '{...}'` | Run a goal; `--async` returns a `job_id` immediately |
| `smctl job status <jobId>` | Poll an async goal job |
| `smctl loop status\|start\|stop\|update <id>` | Loop lifecycle; `update` patches options live |
| `smctl abort <id> [--force]` | Show in-progress work, or release the account with `--force` |
| `smctl combat-mode <id> [flee\|external]` | Get or set the combat-response mode |
| `smctl market <id> <baseId>` | Cached order book (subscribe first) |
| `smctl observation <id>` | Cached observation-watch view (subscribe first) |
| `smctl raw <id> <action> [key=value ...]` | Raw game API passthrough |
| `smctl log-level [level]` | Get or set the log level |
| `smctl help [topic]` | Detailed help — see below |

`smctl help` is the authoritative reference for options, and it is generated
from the same schemas the daemon validates against, so it never drifts from the
code. Topics: `goals`, `loops`, `mining`, `trading`, `hauling`,
`storage-transfer`, `exploration`, `salvage`, `guard`, `roaming-salvage`,
`tow-salvage`, `fuel-rescue`.

Every command returns JSON. Exit codes: `0` success, `1` client error (4xx),
`2` server error (5xx), `3` daemon unreachable, `4` bad arguments, `5` timeout.

## HTTP API Reference

The daemon listens on `http://127.0.0.1:7580` by default. Every `:playerId`
also accepts a username (case-insensitive).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Daemon status and uptime |
| GET | `/dashboard/data` | Per-account state, loop status, recent jobs |
| GET | `/accounts` | List accounts |
| POST | `/accounts` | Connect an owned account (202, connects in background) |
| GET | `/accounts/:playerId` | Account details |
| DELETE | `/accounts/:playerId` | Disconnect and remove |
| POST | `/accounts/register` | Register a new account |
| GET | `/accounts/:playerId/state[/:section]` | Game state, or one section |
| POST | `/accounts/:playerId/state/refresh` | Force a live re-seed of the cache |
| GET | `/accounts/:playerId/system[/:systemId]` | System / POI map |
| POST | `/accounts/:playerId/goal` | Run a goal, wait for the result |
| POST | `/accounts/:playerId/goal/async` | Run a goal in the background (202, returns `job_id`) |
| GET | `/jobs/:jobId` | Async job status |
| POST | `/goals/batch` | One goal across many accounts, keyed by player id |
| GET/POST/PATCH/DELETE | `/accounts/:playerId/loop` | Loop status, start, live option patch, stop |
| POST | `/accounts/:playerId/fleet` | Reconcile the fleet this account leads |
| POST | `/accounts/:playerId/fleet/move` | Move the fleet and ready every member |
| GET/PATCH | `/accounts/:playerId/combat-mode` | Get or set combat-response mode |
| POST | `/accounts/:playerId/combat-heartbeat` | External combat-driver liveness ping |
| DELETE | `/accounts/:playerId/abort` | Release the account from all in-progress work |
| POST | `/accounts/:playerId/raw` | Raw game API passthrough |
| GET | `/accounts/:playerId/market/:baseId` | Cached order book (subscribe first) |
| GET | `/accounts/:playerId/observation` | Cached observation view (subscribe first) |
| GET | `/accounts/:playerId/crafting/events` | Live crafting progress (SSE) |
| GET | `/accounts/:playerId/combat/events` | Live combat events (SSE) |
| GET | `/accounts/:playerId/pirate-radio/events` | Intercepted pirate transmissions (SSE) |
| GET | `/accounts/:playerId/battle-log/events` | Tick-by-tick battle log (SSE) |
| GET/POST | `/log-level` | Get or set the log level |

## Goals

Goals are submitted as `{ type, options }` and are **idempotent** — each one
checks whether it is already satisfied and returns immediately, without
spending a tick, if so.

Around fifty goal types are available, in three layers:

- **Primitives** — one action each: `navigate-to-system`, `go-to-poi`,
  `dock-at`, `ensure-fueled`, `ensure-repaired`, `buy-items`,
  `create-buy-order`, `install-mod`, `reload-weapon`, `scan`, and so on.
- **Compounds** — multi-step sequences that handle travel, docking and the
  operation in one call: `prepare-at-station`, `mining-run`, `buy-at-station`,
  `sell-at-station-priced`, `unload-at-station`, `fuel-rescue`,
  `ensure-loadout`, `ensure-magazines`, `ensure-cargo`, `ensure-hull`.
- **Fleet operations** — spanning several accounts: `ensure-fleet` and
  `fleet-move`, driven from the fleet leader.

Run `smctl help goals` for every type with its exact options. That output is
generated from the validating schemas, so it cannot fall out of date.

### Reconciling goals

The `ensure-*` goals return a richer result. Instead of one pass/fail, they
report **per subject** — per gun, per fleet member, per item stack — with what
was desired, what was found, and what was done:

```json
{
  "success": false,
  "summary": { "total": 5, "changed": 4, "unchanged": 0, "failed": 1 },
  "subjects": [
    { "id": "mod-7", "kind": "weapon", "ok": true, "action": "updated",
      "before": { "ammo": 0 }, "after": { "ammo": 7, "roundsDiscarded": 0 } },
    { "id": "mod-9", "kind": "weapon", "ok": false, "action": "none",
      "message": "insufficient_cargo: tungsten_slug_case",
      "before": { "ammo": 0, "capacity": 7 } }
  ]
}
```

Two properties are worth relying on. `success` is true only if **every** subject
succeeded, so a partial result can never read as a clean one. And a failed
subject always carries `before` — the state actually observed — because the
usual reason a subject fails is that the caller's model was stale, not that the
ship misbehaved.

## Loops

Loops are long-running repeating behaviours. Each account runs at most one at a
time. Configs are persisted to `config/loops/<player_id>.json` and resume
automatically when the daemon restarts.

| Loop | Behaviour |
|------|-----------|
| `mining` | Mine a belt until full, sell at a station, repeat |
| `enhanced-mining` | As above, jettisoning low-value ore to make room for better |
| `salvage` | Work wrecks at a POI and sell the proceeds |
| `roaming-salvage` | Range across systems looking for wrecks |
| `tow-salvage` | Tow wrecks home, then process them |
| `trading` | Buy below a price at one station, sell above a price at another |
| `hauling` | Move goods between storage, market, or another player |
| `storage-transfer` | Shuttle items between personal and faction storage |
| `exploration` | Survey systems and gather intel |
| `guard` | Patrol a POI and engage pirates, returning home to repair |

`smctl help loops` lists them with example JSON; `smctl help <loop>` gives a
detailed reference for most.

Loop status distinguishes a healthy loop from a stuck one: `consecutiveFailures`
and `lastFailure` populate even before the first iteration completes, so a loop
failing repeatedly is not mistaken for one still on its first cycle.

## Combat Response

Entering combat always releases the account from any running loop, goal or job,
so nothing else is fighting for control of the ship. What happens next is set
per account and persisted:

- **`flee`** (default) — setpoint sends the flee stance until the ship escapes.
- **`external`** — setpoint sends no combat commands, leaving the ship to your
  own combat logic.

An `external` driver should POST to `/accounts/:playerId/combat-heartbeat` every
tick it is alive, whether or not it issued a command. If the daemon sees no
heartbeat for five ticks **while the account is in a battle**, it takes the fight
with the built-in flee response rather than leaving a ship that neither fights
nor flees. The configured mode is not changed when that happens.

## Raw API Passthrough

For anything not yet wrapped in a goal, send the call straight through the
account's managed connection:

```json
{ "toolGroup": "spacemolt", "action": "get_nearby", "params": {} }
```

The response is `{ result, structuredContent }`, plus `tick` and `command` for
mutations. Live push events (chat, combat, and so on) arrive on the event
streams, not on command responses, so `raw` does not relay them.

## How It Works

**Declarative model.** You specify outcomes, not API calls. setpoint reads the
current state, works out what is missing, and does only that.

**The game library owns the connection.** setpoint speaks to SpaceMolt through
`@spacemolt/lib`, which holds one WebSocket per account, reconnects and
re-authenticates on drops, and paces connects to stay inside the server's
per-IP limits. A single Clerk API key authenticates every account you own —
there are no per-account passwords stored anywhere.

**One mutation per account per tick.** The game executes mutations on a
ten-second tick, one per account. Queries are unrestricted. The library
serialises mutations per account and retries rate-limited ones itself, so
setpoint does not add a second layer of pacing on top. An awaited mutation does
not resolve until the action actually executes, which for travel can be many
ticks.

**State is push-fed.** Each account has a live cache updated by server pushes
and mutation deltas; that cache is what goals read, so checking state costs no
tick and no wire call. The local SQLite database is a read-only mirror of it,
kept current by a projector, and exists so the HTTP state endpoints can answer
without going through an account's connection.

**Failures are reported, not hidden.** A goal that cannot reach its outcome says
so, with the state it observed. Loops retry a failed iteration and stop after a
bounded number of consecutive failures rather than spinning forever.

**Nothing preempts running work.** Fleet operations that need an account already
running a loop or goal report that as a failure naming the reason; they never
take the account away from it. Releasing an account is a deliberate action
(`smctl abort <id> --force`).

## Security

The API has **no authentication** and binds to `127.0.0.1`. Anything that can
reach the port can command every account. Do not expose it to a network or put
it behind a reverse proxy without adding your own authentication first. See
**[SECURITY.md](SECURITY.md)**.
