import { afterEach, describe, expect, test } from "bun:test";
import type { GetSystemResponse } from "@spacemolt/lib";
import { SetpointClient } from "../src/client.js";

describe("AccountApi.system", () => {
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

	const systemData: GetSystemResponse = {
		action: "get_system",
		security_status: "secure",
	} as GetSystemResponse;

	test("get() with no systemId GETs /accounts/:id/system", async () => {
		mockFetchSequence([{ status: 200, body: systemData }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").system.get();

		expect(result).toEqual(systemData);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/system");
		expect(fetchCalls[0]?.method).toBe("GET");
	});

	test("get(systemId) GETs /accounts/:id/system/:systemId", async () => {
		mockFetchSequence([{ status: 200, body: systemData }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").system.get("sol");

		expect(result).toEqual(systemData);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/system/sol");
		expect(fetchCalls[0]?.method).toBe("GET");
	});

	test("get(systemId) encodeURIComponent's both the account id and systemId", async () => {
		mockFetchSequence([{ status: 200, body: systemData }]);
		const client = new SetpointClient();

		await client.account("Player One").system.get("sol system");

		expect(fetchCalls[0]?.url).toBe(
			"http://127.0.0.1:7580/accounts/Player%20One/system/sol%20system",
		);
	});
});
