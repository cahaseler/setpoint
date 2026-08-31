import { afterEach, describe, expect, test } from "bun:test";
import type { V2GameState } from "@setpoint/protocol";
import { SetpointClient } from "../src/client.js";

describe("AccountApi.state", () => {
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

	// Only the fields these assertions read; cast rather than spelling out the
	// whole of V2Ship.
	const gameState = {
		credits: 5000,
		ship: { hull: 100, max_hull: 100, fuel: 80, max_fuel: 100 },
	} as unknown as V2GameState;

	test("get() GETs /accounts/:id/state and returns the V2GameState", async () => {
		mockFetchSequence([{ status: 200, body: gameState }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").state.get();

		expect(result).toEqual(gameState);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/state");
		expect(fetchCalls[0]?.method).toBe("GET");
	});

	test("get() encodeURIComponent's the account id", async () => {
		mockFetchSequence([{ status: 200, body: gameState }]);
		const client = new SetpointClient();

		await client.account("Player One").state.get();

		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player%20One/state");
	});

	test("section() GETs /accounts/:id/state/:name and returns the section data", async () => {
		const shipSection = { hull: 100, max_hull: 100, fuel: 80, max_fuel: 100 };
		mockFetchSequence([{ status: 200, body: shipSection }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").state.section("ship");

		expect(result).toEqual(shipSection);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/state/ship");
		expect(fetchCalls[0]?.method).toBe("GET");
	});

	test("refresh() POSTs /accounts/:id/state/refresh and returns the refreshed V2GameState", async () => {
		mockFetchSequence([{ status: 200, body: gameState }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").state.refresh();

		expect(result).toEqual(gameState);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/state/refresh");
		expect(fetchCalls[0]?.method).toBe("POST");
		expect(fetchCalls[0]?.body).toBeUndefined();
	});
});
