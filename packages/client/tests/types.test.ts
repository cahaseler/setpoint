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

	test("raw.spacemolt.jump(params) types delta.details to JumpResponse, not unknown", async () => {
		mockFetchOk({
			result: {},
			tick: 1,
			command: "jump",
			structuredContent: {
				details: {
					action: "jump",
					from_system: "alpha",
					system: "Sol",
					system_id: "sol",
					navigation_xp: 5,
				},
			},
		});
		const client = new SetpointClient();

		const result = await client.account("Player1").raw.spacemolt.jump({ id: "sol" });

		// This only typechecks because structuredContent.details is typed as
		// JumpResponse (a union of the direct-jump and bearing-jump shapes),
		// not `unknown` — narrowing on `system_id` (only present on the
		// direct-jump variant) proves the real type made it through.
		const details = result.structuredContent?.details;
		expect(details?.action).toBe("jump");
		if (details && "system_id" in details) {
			expect(details.system_id).toBe("sol");
		} else {
			throw new Error("expected the direct-jump JumpResponse variant");
		}
	});

	test("raw.spacemolt.jump(params)'s details rejects a bogus field at compile time", async () => {
		mockFetchOk();
		const client = new SetpointClient();
		const result = await client.account("Player1").raw.spacemolt.jump({ id: "sol" });

		// @ts-expect-error — "totallyMadeUp" is not a field of JumpResponse.
		const bogus = result.structuredContent?.details?.totallyMadeUp;
		expect(bogus).toBeUndefined();
	});

	test("raw.spacemolt_market.view_market(params) types structuredContent to ViewMarketResponse, not unknown", async () => {
		mockFetchOk({
			result: {},
			structuredContent: {
				action: "view_market",
				base: "Sol Station",
				base_id: "sol_station",
				current_tick: 5,
				items: [],
			},
		});
		const client = new SetpointClient();

		const result = await client
			.account("Player1")
			.raw.spacemolt_market.view_market({ item_id: "iron_ore" });

		// Only typechecks because structuredContent is typed as ViewMarketResponse.
		expect(result.structuredContent?.base_id).toBe("sol_station");
		expect(result.structuredContent?.items).toEqual([]);
	});
});
