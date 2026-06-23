# Contributing to setpoint

Thanks for your interest in contributing. This document explains how to set up a
development environment, the conventions the project follows, and what a pull
request needs to be accepted.

`setpoint` is a Bun + TypeScript (strict) project, linted and formatted with
Biome, and tested with `bun:test`.

## Development Setup

### Prerequisites

- [Bun](https://bun.sh) — the runtime, bundler, test runner, and package manager.
  This project uses Bun for everything; you do not need Node or a separate package
  manager.

### Install

```bash
bun install
```

The `prepare` script runs automatically on install and wires up the git hooks
path:

```jsonc
"prepare": "git config core.hooksPath .githooks"
```

This points git at the project's `.githooks/` directory, which contains a
`pre-commit` hook that runs `bun run check` (see [Git Conventions](#git-conventions)).

## Commands

| Command | What it does |
|---------|--------------|
| `bun test` | Run the unit/integration test suite. |
| `bun run test:coverage` | Run the test suite with a coverage report. |
| `bun run check` | Biome lint + format with `--write` (auto-fixes in place). |
| `bun run lint` | Biome check (no formatting). |
| `bun run lint:fix` | Biome check with `--write`. |
| `bun run format` | Biome format with `--write`. |
| `bun run typecheck` | `tsc --noEmit` — type-check only, no output. |
| `bun run generate` | Regenerate API types from the OpenAPI spec. |
| `bun run build` | Bundle the service entry point to `dist/`. |
| `bun run build:cli` | Compile the standalone `smctl` CLI binary to `dist/smctl`. |
| `bun run start` | Start the setpoint daemon. |
| `bun run dev` | Start the service in watch mode. |
| `bun run smctl <command>` | Run the CLI directly via Bun (no compilation needed). |
| `bun run deploy` | Full release flow (see below). |

### `bun run deploy`

`deploy` is the release flow. It bumps the patch version (when there are
uncommitted changes), runs lint, type-check, and tests, and compiles the
standalone CLI binary (`dist/smctl`). Run it before opening a PR if you have made
changes that should ship, or just rely on the individual commands above during
day-to-day development.

## Testing Conventions

Testing is a core value of this project. The local state model is the heart of
the system, and the test suite is what keeps the CLI, the HTTP server, and the
goal engine honest.

- **~95% coverage target.** Use `bun run test:coverage` to check.
- **Tests mirror `src/`.** A file at `src/server/handlers.ts` has its tests under
  `tests/server/`. Keep the mirrored structure.
- **Mock the HTTP layer — never call the real API.** Tests must not hit the live
  SpaceMolt API. Mock the HTTP layer and use fixture files for response data.

### What must always have a test

New behavior must come with a test written alongside the code, not after.
Specifically:

- **Every CLI command** must have a test that verifies the exact URL and HTTP
  method it calls. This is the only reliable way to catch URL mismatches between
  the CLI and the server router.
- **Every new server route** must have a handler test verifying the handler is
  wired to the correct path.
- **Every new goal/primitive** must have tests covering all three cases:
  already-satisfied, success, and failure / precondition-not-met.
- **Every new option added to an existing goal** must have a test for the new
  behavior.

## Code Style

### TypeScript

The project uses TypeScript in strict mode, including:

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`

Conventions:

- Prefer `interface` over `type` for object shapes.
- Use `unknown` over `any`. `any` is a lint error and must not appear in committed
  code.
- Give all public functions explicit return types.
- Use barrel exports (`index.ts`) per directory.

#### Index signatures and bracket notation

Because `noPropertyAccessFromIndexSignature` is enabled, values typed through an
index signature (e.g. `Record<string, unknown>`) must be accessed with bracket
notation: `obj["key"]`, not `obj.key`. Biome's `useLiteralKeys` rule, which would
otherwise push you the other way, is turned **off** in `biome.json` to avoid this
conflict.

### Biome

Biome runs in strict mode (`recommended` plus additional rules). Notable enforced
rules from `biome.json`:

- `noExplicitAny` — error
- `noNonNullAssertion` — error
- `useConst`, `useExportType`, `useImportType` — error
- `noUnusedVariables`, `noUnusedImports` — error

Formatting is also enforced by Biome: tab indentation, 100-character line width,
double quotes, always semicolons, trailing commas everywhere. Don't fight the
formatter — run `bun run check` and let it format for you.

The `src/generated/`, `openapi/`, `dist/`, and `config/` directories are excluded
from Biome.

## Type Generation

**Never hand-write API types.** All request and response types are generated from
the vendored OpenAPI spec:

```bash
bun run generate
```

- Generated files live in `src/generated/`. They are committed to the repo but
  must never be edited by hand.
- If the API surface changes, update the spec and regenerate — do not patch the
  generated output.

## Git Conventions

- **Conventional commits.** Use prefixes like `feat:`, `fix:`, `chore:`, `test:`,
  etc.
- **The pre-commit hook runs `bun run check`** (Biome lint + format). Do not bypass
  it. If it makes changes or reports errors, fix them and re-stage rather than
  committing around the hook.

## Pull Request Checklist

Before opening a PR, confirm:

- [ ] `bun test` passes.
- [ ] `bun run check` passes (Biome lint + format, no remaining issues).
- [ ] `bun run typecheck` passes.
- [ ] New or changed behavior has tests (see
      [What must always have a test](#what-must-always-have-a-test)).
- [ ] Any API type changes were made by editing the spec and running
      `bun run generate` — `src/generated/` was not hand-edited.
- [ ] Commits follow the conventional-commit format.
- [ ] The pre-commit hook was not bypassed.
