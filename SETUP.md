# Setup Guide

This guide takes you from a fresh clone to a running setpoint daemon managing one or more of your own SpaceMolt accounts.

setpoint is a long-running daemon (Bun + TypeScript) that maintains live game sessions for multiple accounts, tracks game state in a local SQLite database, and exposes a localhost HTTP API plus a CLI (`smctl`) for declarative automation. It has no external runtime dependencies — state is stored with the built-in `bun:sqlite`.

---

## 1. Prerequisites

### Install Bun

The daemon runs on [Bun](https://bun.sh). Install it (see [bun.sh](https://bun.sh) for the official instructions):

```bash
curl -fsSL https://bun.sh/install | bash
```

Verify the install:

```bash
bun --version
```

### Clone and install

```bash
git clone <your-fork-or-repo-url> setpoint
cd setpoint
bun install
```

That installs the dev tooling (Biome, TypeScript) and the `@spacemolt/lib` package, which provides all SpaceMolt API request/response types — there is no local type generation step. The `smctl raw` passthrough (`POST /accounts/:playerId/raw`) makes direct game API calls through the daemon's managed session — no external binary required.

---

## 2. Configuration

The daemon reads everything from a `config/` directory in the project root. This directory is gitignored — it holds your Clerk API key, so treat it as a secret.

```
config/
├── dispatcher.json           # Clerk API key + optional owned-account filter
└── registration.json         # registration code from the SpaceMolt dashboard
```

Create the directory:

```bash
mkdir -p config
```

Account credentials are **not** stored here at all: the daemon is built on `@spacemolt/lib`'s Clerk integration, which owns and authenticates every account tied to your Clerk API key. There is no per-account password file — `connectOwned` connects all of them (optionally narrowed by a filter) on startup.

### `config/dispatcher.json`

Holds the Clerk API key and an optional filter over which owned accounts to connect.

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

Schema (verified in `src/accounts/lib-config.ts`, `parseLibConfig`):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `clerkApiKey` | string | yes* | Your Clerk API key. *Or set `SPACEMOLT_CLERK_API_KEY`, which takes precedence over the file. |
| `accountsFilter` | object | no | Narrows which owned accounts connect. Omit to connect every owned, non-hidden account. |
| `accountsFilter.usernames` | string[] | no | Case-insensitive allowlist. |
| `accountsFilter.empires` | string[] | no | Case-insensitive allowlist. |
| `accountsFilter.includeHidden` | boolean | no | Include accounts hidden in the dashboard. Default `false`. |

All `accountsFilter` clauses AND together.

### `config/registration.json`

Holds the shared registration code from your SpaceMolt dashboard. It is **required** to register brand-new accounts via the daemon (`POST /accounts/register` / `smctl accounts register`); newly-registered accounts are connected and owned by Clerk automatically, so this file is only needed for that one flow.

```json
{
  "registration_code": "code-from-spacemolt-dashboard"
}
```

Schema (verified in `src/accounts/config.ts`, `loadRegistrationConfig`):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `registration_code` | string | yes | Non-empty string from your SpaceMolt dashboard |

### Port and log level

The port comes from the `SM_PORT` environment variable (default `7580`) and the log level from `SM_LOG_LEVEL` (`debug` | `info` | `warn` | `error`), both read in `src/index.ts`. You can also change the log level live with `smctl log-level <level>`.

### Protect your Clerk key

`config/` is gitignored, but `dispatcher.json` still holds a plaintext API key on disk. Lock it down:

```bash
chmod 700 config
chmod 600 config/dispatcher.json config/registration.json
```

---

## 3. Registering vs. adding accounts

You can either register a brand-new SpaceMolt account or connect one you already own in Clerk but that wasn't picked up at startup (e.g. added to Clerk, or excluded by `accountsFilter`, after the daemon last connected).

### Register a new account

Creates a brand-new account using the `registration_code` from `config/registration.json` (the daemon reads it from config — you do **not** pass it in the request body). Pass a username and an empire:

```bash
bun run smctl accounts register --json '{"username":"NewPlayer","empire":"solarian"}'
```

- `username`: 3–24 characters
- `empire`: one of `solarian`, `voidborn`, `crimson`, `nebula`, `outerrim`

On success the account is registered, connected, and owned by your Clerk API key — no local credential file is written.

### Add (connect) an already-owned account

```bash
bun run smctl accounts add --json '{"username":"Player1"}'
```

`username` must belong to an account already owned by the configured Clerk API key. `accounts add` returns **202 Accepted** immediately and connects the account in the background; poll with `smctl accounts list` or `smctl accounts get <playerId>`.

### Rate limits and staggered connection

`@spacemolt/lib`'s `connectOwned`/`connect` stagger authentication internally to stay within the game server's per-IP rate limits, so a fleet of owned accounts comes online gradually rather than all at once. This is expected — check progress with `smctl accounts list` or `smctl accounts get <playerId>`. Avoid restarting the daemon repeatedly in a short window, which can trip the auth rate limit.

---

## 4. Run the daemon

```bash
bun run start          # start the daemon
bun run dev            # start with watch/reload for development
```

On startup the daemon loads `config/`, opens (or creates) `data/dispatcher.db`, starts the HTTP server, then connects every owned account (per `accountsFilter`, if set) in the background via `@spacemolt/lib`'s `connectOwned` (staggered internally). The HTTP server comes up immediately so health checks and state queries work while accounts are still connecting.

### Binding and security

By default the daemon binds to **`127.0.0.1:7580`** (loopback only).

| Variable | Default | Purpose |
|----------|---------|---------|
| `SM_PORT` | `7580` | HTTP port |
| `SM_HOST` | `127.0.0.1` | Bind interface |
| `SM_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

> **Security warning:** the daemon has **no authentication**. Anyone who can reach the port has full control of your accounts. Keep it on loopback. Only set `SM_HOST` (e.g. to `0.0.0.0`) on a trusted, isolated host where you have your own access controls in front of it — never expose it directly to a public network.

---

## 5. First-run verification

With the daemon running, open another terminal:

```bash
# 1. Daemon is up
bun run smctl health

# 2. List accounts (connected + pending)
bun run smctl accounts list

# 3. Full status dashboard for every account
bun run smctl status
```

`smctl health` should return an OK status with uptime. `accounts list` shows each account and whether it has finished connecting (give the stagger a minute for larger fleets). `smctl status` returns the JSON dashboard with per-account state, loop status, and recent jobs.

Once an account shows as connected, you can query its cached state without spending a game tick:

```bash
bun run smctl state Player1            # full game state
bun run smctl state Player1 ship       # one section
```

All `:playerId` arguments accept either the `player_id` UUID or the username (case-insensitive).

---

## 6. (Optional) Build the standalone `smctl` binary

For convenience you can compile a single self-contained `smctl` executable:

```bash
bun run build:cli      # → dist/smctl
```

Then run it directly instead of going through Bun:

```bash
dist/smctl health
dist/smctl accounts list
```

---

## Next steps

- `bun run smctl help` — full command list
- `bun run smctl help goals` — one-off goal types and their options
- `bun run smctl help loops` — repeating loop types (mining, trading, hauling, etc.)
- See `README.md` for the full HTTP API and goal/loop reference.
