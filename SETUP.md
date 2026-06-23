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

That installs the dev dependencies (Biome, TypeScript, `openapi-typescript`). There are no production runtime dependencies to install.

---

## 2. (Optional) The third-party `spacemolt` CLI binary

The `smctl raw` passthrough command shells out to an external **`spacemolt`** CLI binary so you can issue arbitrary game API calls using the daemon's managed session token. **This binary is not included in this repository** — obtain it separately if you want the `smctl raw` feature.

Everything else (goals, loops, state queries, account management, and the `POST /accounts/:playerId/raw` HTTP passthrough) works without it. You only need the `spacemolt` binary for the `smctl raw <playerId> ...` command.

`smctl` resolves the binary in this order (from `src/cli/commands.ts`):

1. The path in the `SPACEMOLT_CLI` environment variable, if set and it exists.
2. A file named `spacemolt` sitting next to the `smctl` binary, or one directory up (covers the `dist/` layout).
3. `spacemolt` on your system `PATH`.

So either put `spacemolt` on your `PATH`, drop it next to `smctl`, or point at it explicitly:

```bash
export SPACEMOLT_CLI=/absolute/path/to/spacemolt
```

If the binary cannot be found, `smctl raw` prints an error and exits; no other command is affected.

---

## 3. (Optional) Regenerating API types

All SpaceMolt API request/response types are generated from the OpenAPI spec into `src/generated/api-types.ts`. **These generated types are committed**, so a normal clone, build, and run needs no type generation and no network access.

You only need to regenerate if you are updating against a newer game server API:

```bash
bun run generate
```

Note: this repository does **not** vendor the OpenAPI spec. When no vendored spec is present, the generate script fetches it live from `https://game.spacemolt.com/api/v2/openapi.json`, so this step requires network access (verified in `scripts/generate-types.ts`).

---

## 4. Configuration

The daemon reads everything from a `config/` directory in the project root. This directory is gitignored — it holds your plaintext credentials, so treat it as a secret.

```
config/
├── registration.json        # registration code from the SpaceMolt dashboard
└── accounts/
    ├── player1.json         # one file per account
    └── player2.json
```

Create the directory layout:

```bash
mkdir -p config/accounts
```

### `config/registration.json`

Holds the shared registration code from your SpaceMolt dashboard. It is **required** to register brand-new accounts via the daemon; if you only ever add already-existing accounts, the registration step won't read it.

```json
{
  "registration_code": "code-from-spacemolt-dashboard"
}
```

Schema (verified in `src/accounts/config.ts`):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `registration_code` | string | yes | Non-empty string from your SpaceMolt dashboard |

### `config/accounts/<name>.json`

One JSON file per account. The filename is up to you (the daemon loads every `*.json` file in the directory, sorted by name). Each file matches the API registration response format:

```json
{
  "username": "Player1",
  "password": "generated-password",
  "player_id": "00000000-0000-0000-0000-000000000000"
}
```

Schema (verified in `src/accounts/config.ts`, `parseAccountConfig`):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `username` | string | yes | Non-empty |
| `password` | string | yes | Non-empty |
| `player_id` | string | yes | Non-empty; the account UUID |

> Note: account config files loaded at daemon startup require all three fields including `player_id`. (When you *add* an account at runtime via the API/CLI, you may omit `player_id` and the daemon discovers it by logging in — see section 5. Files written by that flow always include all three fields.)

### Port and log level

There is no `dispatcher.json` — the daemon does not read a config file for these. The port comes from the `SM_PORT` environment variable (default `7580`) and the log level from `SM_LOG_LEVEL` (`debug` | `info` | `warn` | `error`), both read in `src/index.ts`. You can also change the log level live with `smctl log-level <level>`.

### Protect your credentials

`config/` is gitignored, but it still holds plaintext passwords on disk. Lock the files down:

```bash
chmod 700 config config/accounts
chmod 600 config/registration.json config/accounts/*.json
```

---

## 5. Registering vs. adding accounts

You can either register a brand-new SpaceMolt account or add an account you already have. Both can be done at startup (by dropping config files in `config/accounts/`) or at runtime via `smctl` once the daemon is running.

### Register a new account

Creates a brand-new account using the `registration_code` from `config/registration.json` (the daemon reads it from config — you do **not** pass it in the request body). Pass a username and an empire:

```bash
bun run smctl accounts register --json '{"username":"NewPlayer","empire":"solarian"}'
```

- `username`: 3–24 characters
- `empire`: one of `solarian`, `voidborn`, `crimson`, `nebula`, `outerrim`

On success the daemon writes the resulting credentials to `config/accounts/<slug>.json` for you.

### Add an existing account

Provide full credentials:

```bash
bun run smctl accounts add --json '{"username":"Player1","password":"generated-password","player_id":"<uuid>"}'
```

Or credentials only — the daemon discovers `player_id` by logging in:

```bash
bun run smctl accounts add --json '{"username":"Player1","password":"generated-password"}'
```

`accounts add` returns **202 Accepted** immediately and connects the account in the background.

### Rate limits and staggered connection

Account connections are queued and staggered automatically to stay within the game server's per-IP rate limits:

- **Session creation:** 20/min
- **Auth (login/register):** 10/min

So when you add many accounts (or start the daemon with many configured), they come online gradually (~6.5s apart) rather than all at once. This is expected — check progress with `smctl accounts list` or `smctl accounts get <playerId>`. Avoid restarting the daemon repeatedly in a short window, which can trip the auth rate limit.

---

## 6. Run the daemon

```bash
bun run start          # start the daemon
bun run dev            # start with watch/reload for development
```

On startup the daemon loads `config/`, opens (or creates) `data/dispatcher.db`, starts the HTTP server, then connects configured accounts in the background (staggered). The HTTP server comes up immediately so health checks and state queries work while accounts are still connecting.

### Binding and security

By default the daemon binds to **`127.0.0.1:7580`** (loopback only).

| Variable | Default | Purpose |
|----------|---------|---------|
| `SM_PORT` | `7580` | HTTP port |
| `SM_HOST` | `127.0.0.1` | Bind interface |
| `SM_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

> **Security warning:** the daemon has **no authentication**. Anyone who can reach the port has full control of your accounts. Keep it on loopback. Only set `SM_HOST` (e.g. to `0.0.0.0`) on a trusted, isolated host where you have your own access controls in front of it — never expose it directly to a public network.

---

## 7. First-run verification

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

## 8. (Optional) Build the standalone `smctl` binary

For convenience you can compile a single self-contained `smctl` executable:

```bash
bun run build:cli      # → dist/smctl
```

Then run it directly instead of going through Bun:

```bash
dist/smctl health
dist/smctl accounts list
```

If you use `smctl raw`, remember the binary resolution from section 2 — placing the `spacemolt` binary in `dist/` (next to the compiled `smctl`) is one of the supported locations.

---

## Next steps

- `bun run smctl help` — full command list
- `bun run smctl help goals` — one-off goal types and their options
- `bun run smctl help loops` — repeating loop types (mining, trading, hauling, etc.)
- See `README.md` for the full HTTP API and goal/loop reference.
