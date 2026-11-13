import { afterEach, describe, expect, test } from "bun:test";
import { SetpointClient } from "../src/client.js";

describe("AccountApi.hazardMode", () => {
	const originalFetch = globalThis.fetch;
	let calls: Array<{ url: string; method: string | undefined; body: unknown }>;

	function mockFetch(body: unknown): void {
		calls = [];
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			calls.push({
				url: url.toString(),
				method: init?.method,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as typeof fetch;
	}

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("get() GETs /accounts/:id/hazard-mode", async () => {
		mockFetch({ playerId: "p1", mode: "retreat" });
		const result = await new SetpointClient().account("Player One").hazardMode.get();

		expect(result).toEqual({ playerId: "p1", mode: "retreat" });
		expect(calls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player%20One/hazard-mode");
		expect(calls[0]?.method).toBe("GET");
	});

	test("set() PATCHes the setting, including tolerate's hull floor", async () => {
		mockFetch({ playerId: "p1", mode: "tolerate", minHullPct: 40 });
		await new SetpointClient().account("p1").hazardMode.set({ mode: "tolerate", minHullPct: 40 });

		expect(calls[0]?.method).toBe("PATCH");
		expect(calls[0]?.url).toBe("http://127.0.0.1:7580/accounts/p1/hazard-mode");
		expect(calls[0]?.body).toEqual({ mode: "tolerate", minHullPct: 40 });
	});
});
