/**
 * Type-level tests for `RawApi` (`packages/client/src/raw.ts`). The
 * `@ts-expect-error` lines are what's actually being tested here — they're
 * checked by `tsc --noEmit` (via `bun run typecheck`), not by the runtime
 * assertions below. `bun test` also executes this file, so every case still
 * mocks `fetch` and makes a trivial runtime assertion, matching the
 * `@ts-expect-error`-in-a-test pattern used in `account-goals.test.ts` —
 * this avoids hitting a real (likely absent) daemon and keeps the suite fast.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { RawEnvelope } from "@setpoint/protocol";
import { SetpointClient } from "../src/client.js";

describe("RawApi types", () => {
	const originalFetch = globalThis.fetch;

	function mockFetchOk(body: unknown = {}): void {
		globalThis.fetch = ((_url: string | URL | Request, _init?: RequestInit) =>
			Promise.resolve(
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)) as typeof fetch;
	}

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("raw.spacemolt.jump(params) returns Promise<RawEnvelope>", async () => {
		const envelope: RawEnvelope = { result: {}, tick: 1, command: "jump" };
		mockFetchOk(envelope);
		const client = new SetpointClient();

		const call: Promise<RawEnvelope> = client.account("Player1").raw.spacemolt.jump({ id: "sol" });

		expect(await call).toEqual(envelope);
	});

	test("raw.spacemolt.jump(params) rejects mistyped params at compile time", async () => {
		mockFetchOk();
		const client = new SetpointClient();
		const account = client.account("Player1");

		// @ts-expect-error — "wrong" is not `SpacemoltJumpParams`; `id` is required.
		const call = account.raw.spacemolt.jump({ wrong: 1 });
		await call;
		expect(call).toBeInstanceOf(Promise);
	});

	test("raw.<unknown group> fails to compile", () => {
		const client = new SetpointClient();
		const account = client.account("Player1");

		// @ts-expect-error — "nonsense" is not a key of `Commands`.
		const group = account.raw.nonsense;
		expect(group).toBeDefined();
	});

	test("raw.spacemolt.<unknown action> fails to compile", async () => {
		mockFetchOk();
		const client = new SetpointClient();
		const account = client.account("Player1");

		// @ts-expect-error — "notacommand" is not a key of `Commands["spacemolt"]`.
		const call = account.raw.spacemolt.notacommand({ id: "sol" });
		await call;
		expect(call).toBeInstanceOf(Promise);
	});
});
