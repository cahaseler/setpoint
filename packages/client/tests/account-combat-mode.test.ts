import { afterEach, describe, expect, test } from "bun:test";
import type { CombatModeStatus } from "@setpoint/protocol";
import { SetpointClient } from "../src/client.js";

describe("AccountApi.combatMode", () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls: Array<{ url: string; method: string | undefined; body: unknown }>;

	function parseBody(init: RequestInit | undefined): unknown {
		if (typeof init?.body !== "string") return undefined;
		return JSON.parse(init.body);
	}

	function mockFetchSequence(responses: Array<{ status: number; body: unknown }>): void {
		fetchCalls = [];
		let call = 0;
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: url.toString(), method: init?.method, body: parseBody(init) });
			const next = responses[Math.min(call, responses.length - 1)];
			call++;
			return Promise.resolve(
				new Response(JSON.stringify(next?.body), {
					status: next?.status ?? 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as typeof fetch;
	}

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("get() GETs /accounts/:id/combat-mode and returns the CombatModeStatus", async () => {
		const status: CombatModeStatus = { playerId: "p1", mode: "flee" };
		mockFetchSequence([{ status: 200, body: status }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").combatMode.get();

		expect(result).toEqual(status);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/combat-mode");
		expect(fetchCalls[0]?.method).toBe("GET");
		expect(fetchCalls[0]?.body).toBeUndefined();
	});

	test('set() PATCHes /accounts/:id/combat-mode with {mode: "external"} and returns the CombatModeStatus', async () => {
		const status: CombatModeStatus = { playerId: "p1", mode: "external" };
		mockFetchSequence([{ status: 200, body: status }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").combatMode.set("external");

		expect(result).toEqual(status);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/combat-mode");
		expect(fetchCalls[0]?.method).toBe("PATCH");
		expect(fetchCalls[0]?.body).toEqual({ mode: "external" });
	});

	test("set() rejects an invalid mode at compile time", async () => {
		mockFetchSequence([{ status: 200, body: { playerId: "p1", mode: "flee" } }]);
		const client = new SetpointClient();

		// @ts-expect-error — "berserk" is not a valid CombatMode
		await client.account("Player1").combatMode.set("berserk");
	});
});
