# Security

## Threat model

setpoint is designed to run as a **single-user daemon on a trusted host**,
reachable only over the loopback interface. Under that model it has **no
authentication** on its HTTP API — anyone who can reach the port is assumed to
be the operator.

This is a deliberate trade-off for a personal automation tool, but it has sharp
edges. Read this before running it anywhere other than your own machine.

## The local API is unauthenticated

Every endpoint on the HTTP API (default `http://127.0.0.1:7580`) is unauthenticated.
A client that can reach the port can, among other things:

- list every managed account and read its live **session token**
  (`GET /accounts/:id/session`),
- execute goals and start/stop loops on any account,
- add or remove accounts,
- issue arbitrary game-API calls through the raw passthrough.

Because there is no auth, **the only thing protecting the daemon is the network
boundary.**

### Bind address

The server binds to `127.0.0.1` by default, so it is not reachable from the
network. You can override the interface with the `SM_HOST` environment variable
(for example `SM_HOST=0.0.0.0`), but **do not** do this on an untrusted network
without putting your own authentication in front of the daemon (e.g. a reverse
proxy with auth, an SSH tunnel, or a firewall that restricts the port). Binding
to `0.0.0.0` with no auth exposes full control of every account to anyone who
can reach the port.

### Browser-originated requests

The API sets no CORS headers, so browsers will block cross-origin *reads*.
However, a malicious web page you visit can still send no-CORS `POST` requests
to `http://127.0.0.1:7580/...`. Keeping the daemon bound to loopback does not
fully mitigate this. If this concerns you, run the daemon on a non-default port
and/or add an authenticating proxy.

## Credentials on disk

The daemon does not store per-account passwords at all. It authenticates via
`@spacemolt/lib`'s Clerk integration: `config/dispatcher.json` holds a single
**plaintext Clerk API key** (`clerkApiKey`), which owns and authenticates every
account tied to it — effectively a master credential for your whole fleet. The
`config/` directory is gitignored and is never committed. Protect it with
restrictive file permissions:

```bash
chmod 700 config
chmod 600 config/dispatcher.json
```

The account-registration endpoint still returns the newly generated per-account
password in its HTTP response body — necessary so you can save it, but another
reason the API must stay off the network.

## Logs

Session tokens are bearer credentials. The daemon redacts them in logs (only a
short prefix is written). Logs may still contain account usernames, player IDs,
and game state. Treat `logs/` as sensitive and do not share it unredacted.

## The raw passthrough

`POST /accounts/:id/raw` (and `smctl raw`) relay arbitrary game-API calls under
the account's managed session — this is intentional, to support operations not
yet wrapped in a goal. The `toolGroup` and `action` are restricted to
`[A-Za-z0-9_]` so they cannot escape the `/api/v2/<group>/<action>` path, but the
endpoint can still invoke any game action the session is authorized for. It must
never be network-reachable.

The `/gameproxy/*` endpoint is a related relay: `smctl raw` points the spawned
`spacemolt` CLI at it so the CLI's traffic is branded and compressed like the
rest of the daemon's egress. It is constrained to the `/api/v2/` path namespace,
but likewise forwards under a managed session and must stay off the network.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue. Use
GitHub's **private vulnerability reporting** (the "Report a vulnerability" button
under the repository's *Security* tab) so the report stays confidential until a
fix is available.
