# setpoint

**setpoint is a declarative control plane for your SpaceMolt fleet.** Tell it the outcome you want — *"be docked and fully fueled at Trader's Rest"*, *"mine this belt until the hold is full, then sell"*, *"run this buy-low / sell-high trade loop"* — and it works out the steps and carries them out. You describe **what**; setpoint figures out **how**.

It's built for players who automate. SpaceMolt rewards multi-account play and scripted routines, but most of that work isn't strategy — it's plumbing: logging a dozen accounts in, keeping sessions alive across the server's frequent restarts, pacing one mutation per ten-second tick, staying under the rate limits, and tracking every ship's state. setpoint owns all of it. It runs as a local daemon that holds your accounts' sessions, keeps a live SQLite model of every ship, and exposes the whole fleet through a small local HTTP API and a CLI (`smctl`).

That makes it a **substrate for your own tools.** Point a script, an LLM agent, or a fleet-brain at setpoint and let it reason in goals and loops — *"make this account do X"* — instead of reimplementing session management, rate-limit accounting, and tick timing. Your tools decide what to do; setpoint handles how to do it, reliably, across the whole fleet.

> **Unofficial third-party tool.** This is a community automation client for SpaceMolt, not an official product of the game's operators. Run it with your own accounts at your own discretion.

## Quick Start

```bash
bun install
# Configure accounts in config/accounts/<name>.json:
# { "username": "...", "password": "...", "player_id": "..." }
bun run start            # Start daemon (default port 7580, localhost only)
bun run smctl health     # Verify daemon is running
```

For full installation and configuration, see **[SETUP.md](SETUP.md)**.

## Documentation

- **[SETUP.md](SETUP.md)** — installation and first-run guide
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the daemon is structured
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — development workflow and conventions
- **[SECURITY.md](SECURITY.md)** — trust model and vulnerability reporting

## CLI Reference

All commands are available via `smctl`. Options `--port <n>`, `--json '<json>'`, and `--stdin` apply globally.

| Command | Description |
|---------|-------------|
| `smctl health` | Check daemon health |
| `smctl accounts list` | List connected accounts |
| `smctl accounts get <id>` | Get account details and state summary |
| `smctl accounts add --json '{...}'` | Add existing account |
| `smctl accounts register --json '{...}'` | Register new account |
| `smctl accounts remove <id>` | Disconnect and remove account |
| `smctl state <id> [section]` | Get game state (sections: player, ship, cargo, location, modules, skills, missions, queue) |
| `smctl goal <id> --json '{...}'` | Execute a one-off goal |
| `smctl loop status <id>` | Check loop status |
| `smctl loop start <id> --json '{...}'` | Start a repeating loop |
| `smctl loop stop <id>` | Stop running loop |
| `smctl raw <id> --json '{...}'` | Raw API passthrough |
| `smctl log-level [level]` | Get/set log level |
| `smctl help [topic]` | Show help (topics: goals, loops, trading, hauling) |

## HTTP API Reference

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns daemon status |

### Accounts

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/accounts` | — | List all accounts |
| POST | `/accounts` | `{ username, password, player_id }` | Add existing account |
| GET | `/accounts/:playerId` | — | Get account details and state summary |
| DELETE | `/accounts/:playerId` | — | Disconnect and remove account |
| POST | `/accounts/register` | `{ username, empire }` | Register new account (uses `registration_code` from `config/registration.json`) |

### State

| Method | Path | Description |
|--------|------|-------------|
| GET | `/accounts/:playerId/state` | Full game state from local cache |
| GET | `/accounts/:playerId/state/:section` | Single section: `player`, `ship`, `cargo`, `location`, `modules`, `skills`, `missions`, `queue` |

### Goals

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/accounts/:playerId/goal` | `{ type, options }` | Execute a one-off goal and wait for result |

### Loops

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/accounts/:playerId/loop` | — | Get current loop status |
| POST | `/accounts/:playerId/loop` | `{ type, options }` | Start a repeating loop |
| DELETE | `/accounts/:playerId/loop` | — | Stop running loop |

### Raw API Passthrough

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/accounts/:playerId/raw` | `{ toolGroup, action, params }` | Pass a call directly to the SpaceMolt API |

### Config

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/log-level` | — | Get current log level |
| POST | `/log-level` | `{ level }` | Set log level |

## Goal Types Reference

Goals are submitted as `{ type, options }`. Goals check current state first — if the goal is already satisfied, they succeed immediately without making API calls.

### Navigation

| Goal | Required | Optional |
|------|----------|---------|
| `navigate-to-system` | `targetSystemId` (string) | — |
| `go-to-poi` | `targetPoiId` (string) | — |
| `dock-at` | `targetBaseId` (string) | — |
| `ensure-undocked` | — | — |
| `ensure-fueled` | — | `targetFuel` (number) |
| `ensure-repaired` | — | — |

### Cargo & Market

| Goal | Required | Optional |
|------|----------|---------|
| `sell-or-deposit-cargo` | — | — (sells all cargo, deposits unsold to personal storage) |
| `ensure-empty-cargo` | — | — |
| `jettison-cargo` | `itemId` (string), `quantity` (number) | — |
| `load-from-storage` | `itemId` (string) | `maxQuantity` (number) |
| `buy-items` | `items: Array<{ itemId, maxPrice }>` | `items[].maxQuantity` |
| `list-cargo-for-sale` | `items: Array<{ itemId, minPrice }>` | — |
| `create-buy-order` | `itemId`, `quantity`, `price` | — |
| `create-sell-order` | `itemId`, `quantity`, `price` | — |

### Faction Storage

| Goal | Required | Optional |
|------|----------|---------|
| `deposit-to-faction-storage` | `itemId` (string), `quantity` (number) | — |
| `withdraw-from-faction-storage` | `itemId` (string) | `quantity` (number) |
| `load-from-faction-storage` | `itemId` (string) | `maxQuantity` (number) |
| `gift-to-player` | `targetName`, `itemId`, `quantity` | `message` (string) |

### Items

| Goal | Required | Optional |
|------|----------|---------|
| `use-item` | `itemId` (string) | — |

> Managed crafting goals (`craft`, `craft-batch`) and the `crafting` loop were removed when the game moved crafting to an asynchronous job queue. Submit and track craft jobs directly through the [raw passthrough](#raw-api-passthrough).

### Missions

| Goal | Required | Optional |
|------|----------|---------|
| `accept-mission` | `missionId` (string) | — |
| `complete-mission` | `missionId` (string) | — |
| `abandon-mission` | `missionId` (string) | — |

### Ship Modules

| Goal | Required | Optional |
|------|----------|---------|
| `install-mod` | `moduleId` (string) | — |
| `uninstall-mod` | `moduleId` (string) | — |

### Scanning

| Goal | Required | Optional |
|------|----------|---------|
| `scan` | — | — |

### Compound Goals

Compound goals execute multi-step sequences built from primitives. They handle navigation, docking, and the requested operation in a single call.

| Goal | Required | Optional |
|------|----------|---------|
| `prepare-at-station` | `systemId`, `poiId`, `baseId` | `refuel` (bool), `repair` (bool) |
| `sell-at-station` | `systemId`, `stationPoiId`, `baseId` | `refuel` (bool) |
| `buy-at-station` | `systemId`, `poiId`, `baseId`, `items: Array<{ itemId, maxPrice, maxQuantity? }>` | `refuel` (bool) |
| `sell-at-station-priced` | `systemId`, `stationPoiId`, `baseId`, `items: Array<{ itemId, minPrice }>` | `refuel` (bool) |
| `load-at-station` | `systemId`, `poiId`, `baseId`, `sourceType` ("personal-storage"\|"faction-storage"\|"market"), `items` | `refuel` (bool) |
| `unload-at-station` | `systemId`, `poiId`, `baseId`, `destType` ("personal-storage"\|"faction-storage"\|"gift"\|"market") | `targetPlayer` (required for gift), `items`, `refuel` (bool) |
| `mine-until-full` | — | `fullThreshold` (number), `maxAttempts` (number) |
| `mining-run` | `systemId`, `beltPoiId` | `fullThreshold` (number), `maxAttempts` (number) |
| `enhanced-mining-run` | `systemId`, `beltPoiId`, `junkItemIds: string[]` | `fullThreshold`, `maxAttempts`, `maxJettisonRounds` |
| `mine-with-jettison` | `junkItemIds: string[]` | `fullThreshold`, `maxAttempts`, `maxJettisonRounds` |

## Loop Types Reference

Loops are long-running repeating behaviors. Each account supports one active loop at a time.

### mining

Mine ore at a belt, then travel to a station and sell all cargo. Repeat.

**Options:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `miningSystemId` | string | yes | System containing the asteroid belt |
| `beltPoiId` | string | yes | POI ID of the asteroid belt |
| `sellSystemId` | string | yes | System containing the sell station |
| `sellStationPoiId` | string | yes | POI ID of the sell station |
| `sellBaseId` | string | yes | Base ID at the sell station |
| `fullThreshold` | number | no | Cargo fill ratio to consider "full" (default 0.9) |
| `maxAttempts` | number | no | Max mine attempts per fill cycle |
| `maxIterations` | number | no | Max loop iterations before stopping |

```json
{
  "type": "mining",
  "options": {
    "miningSystemId": "sol",
    "beltPoiId": "asteroid-belt-1",
    "sellSystemId": "sol",
    "sellStationPoiId": "sol-station",
    "sellBaseId": "sol-base",
    "fullThreshold": 0.9,
    "maxAttempts": 100,
    "maxIterations": 50
  }
}
```

### enhanced-mining

Mine ore, jettison low-value items to make room for better ore, continue mining until full, then sell. Repeat.

**Options:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `miningSystemId` | string | yes | System containing the asteroid belt |
| `beltPoiId` | string | yes | POI ID of the asteroid belt |
| `sellSystemId` | string | yes | System containing the sell station |
| `sellStationPoiId` | string | yes | POI ID of the sell station |
| `sellBaseId` | string | yes | Base ID at the sell station |
| `junkItemIds` | string[] | yes | Item IDs to jettison when cargo is full |
| `fullThreshold` | number | no | Cargo fill ratio to consider "full" (default 0.9) |
| `maxAttempts` | number | no | Max mine attempts per fill cycle |
| `maxJettisonRounds` | number | no | Max jettison rounds before selling anyway |
| `maxIterations` | number | no | Max loop iterations before stopping |

```json
{
  "type": "enhanced-mining",
  "options": {
    "miningSystemId": "sol",
    "beltPoiId": "asteroid-belt-1",
    "sellSystemId": "sol",
    "sellStationPoiId": "sol-station",
    "sellBaseId": "sol-base",
    "junkItemIds": ["stone", "ice"],
    "fullThreshold": 0.9,
    "maxAttempts": 100,
    "maxJettisonRounds": 3,
    "maxIterations": 50
  }
}
```

### trading

Travel to a buy station and purchase items below max price, then travel to a sell station and sell above min price. Repeat.

**Options:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `buyStation.systemId` | string | yes | System of the buy station |
| `buyStation.poiId` | string | yes | POI ID of the buy station |
| `buyStation.baseId` | string | yes | Base ID at the buy station |
| `sellStation.systemId` | string | yes | System of the sell station |
| `sellStation.stationPoiId` | string | yes | POI ID of the sell station |
| `sellStation.baseId` | string | yes | Base ID at the sell station |
| `items` | Array | yes | Items to trade |
| `items[].itemId` | string | yes | Item to buy and sell |
| `items[].maxBuyPrice` | number | yes | Skip buying if market price exceeds this |
| `items[].minSellPrice` | number | yes | Skip selling if market price is below this |
| `items[].maxQuantity` | number | no | Cap quantity purchased per iteration |
| `refuel` | boolean | no | Refuel at each station |
| `maxIterations` | number | no | Max loop iterations before stopping |

```json
{
  "type": "trading",
  "options": {
    "buyStation": {
      "systemId": "alpha",
      "poiId": "alpha-station",
      "baseId": "alpha-base"
    },
    "sellStation": {
      "systemId": "beta",
      "stationPoiId": "beta-station",
      "baseId": "beta-base"
    },
    "items": [
      { "itemId": "copper_ore", "maxBuyPrice": 8, "minSellPrice": 15 },
      { "itemId": "iron_ore", "maxBuyPrice": 5, "minSellPrice": 12, "maxQuantity": 50 }
    ],
    "refuel": true,
    "maxIterations": 100
  }
}
```

### hauling

Load items from a source location, travel to a destination, unload. Repeat.

Source and destination `type` values:
- `"personal-storage"` — the account's personal storage at that base
- `"faction-storage"` — the faction's shared storage at that base
- `"market"` — buy from or list on the market at that base
- `"gift"` — deliver directly to another player (destination only; requires `targetPlayer`)

**Example: personal storage to faction storage**

```json
{
  "type": "hauling",
  "options": {
    "source": {
      "systemId": "sol",
      "poiId": "sol-station",
      "baseId": "sol-base",
      "type": "personal-storage",
      "items": [{ "itemId": "iron_bar", "quantity": 50 }]
    },
    "destination": {
      "systemId": "alpha",
      "poiId": "alpha-station",
      "baseId": "alpha-base",
      "type": "faction-storage"
    },
    "refuel": true,
    "maxIterations": 10
  }
}
```

**Example: market buy to gift delivery**

```json
{
  "type": "hauling",
  "options": {
    "source": {
      "systemId": "sol",
      "poiId": "sol-station",
      "baseId": "sol-base",
      "type": "market",
      "items": [{ "itemId": "fuel_cell", "maxPrice": 20, "quantity": 10 }]
    },
    "destination": {
      "systemId": "sol",
      "poiId": "sol-station",
      "baseId": "sol-base",
      "type": "gift",
      "targetPlayer": "FriendName"
    },
    "maxIterations": 5
  }
}
```

**Example: faction storage to market listing**

```json
{
  "type": "hauling",
  "options": {
    "source": {
      "systemId": "alpha",
      "poiId": "alpha-station",
      "baseId": "alpha-base",
      "type": "faction-storage",
      "items": [{ "itemId": "copper_ore" }]
    },
    "destination": {
      "systemId": "beta",
      "poiId": "beta-station",
      "baseId": "beta-base",
      "type": "market",
      "items": [{ "itemId": "copper_ore", "minPrice": 15 }]
    },
    "refuel": true
  }
}
```

## Raw API Passthrough

For operations not yet wrapped in goals, send the call directly to the SpaceMolt API:

```json
{ "toolGroup": "spacemolt", "action": "get_nearby", "params": {} }
```

The response envelope (`result`, `structuredContent`, `notifications`, `session`, `error`) is returned as-is, and `structuredContent` is still applied to the local state cache.

## Loop Persistence

- Loops auto-save to `config/loops/<player_id>.json` when started
- On daemon restart, all saved loops are automatically resumed
- The loop config file is deleted when the loop stops or completes normally
- Loops are deterministic — if interrupted mid-iteration, they resume from current game state on next start

## Key Concepts for AI Agents

**Declarative model**: Specify desired outcomes, not individual API calls. setpoint determines the current state and plans what actions are needed.

**Idempotent goals**: Every goal checks whether it is already satisfied before acting. If a ship is already at the target system, `navigate-to-system` returns success immediately without spending a tick.

**Rate limits**: The SpaceMolt API allows one mutation per 10-second game tick per account. Query endpoints (`get_state`, `get_cargo`, `get_nearby`, etc.) are unlimited. setpoint enforces this automatically.

**State caching**: Game state is stored in a local SQLite database and updated after every mutation response. Reading state via setpoint does not consume ticks.

**Error behavior**: API errors in primitive goals terminate the current loop iteration with an error result. The loop configuration persists, so restarting the daemon will auto-resume the loop from current game state.

**One account, one loop**: Each account can run at most one loop at a time. Starting a new loop replaces any existing loop for that account.

**Session management**: The daemon handles keepalive polling (every 10–15 minutes), automatic re-login on session expiry (401), and staggered session creation on startup to stay within the 20/min session creation limit.
