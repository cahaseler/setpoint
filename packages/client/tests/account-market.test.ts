import { afterEach, describe, expect, test } from "bun:test";
import type { MarketBookSnapshot } from "@setpoint/protocol";
import { SetpointClient } from "../src/client.js";

describe("AccountApi.market", () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls: Array<{ url: string; method: string | undefined }>;

	function mockFetchSequence(responses: Array<{ status: number; body: unknown }>): void {
		fetchCalls = [];
		let call = 0;
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: url.toString(), method: init?.method });
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

	const book: MarketBookSnapshot = {
		base_id: "base-1",
		base_name: "Test Station",
		tick: 5,
		items: [{ item_id: "iron_ore", buy_orders: [], sell_orders: [] }],
	};

	test("get(baseId) GETs /accounts/:id/market/:baseId", async () => {
		mockFetchSequence([{ status: 200, body: book }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").market.get("base-1");

		expect(result).toEqual(book);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/market/base-1");
		expect(fetchCalls[0]?.method).toBe("GET");
	});

	test("get(baseId) encodeURIComponent's both the account id and baseId", async () => {
		mockFetchSequence([{ status: 200, body: book }]);
		const client = new SetpointClient();

		await client.account("Player One").market.get("base one");

		expect(fetchCalls[0]?.url).toBe(
			"http://127.0.0.1:7580/accounts/Player%20One/market/base%20one",
		);
	});
});
