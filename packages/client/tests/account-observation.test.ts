import { afterEach, describe, expect, test } from "bun:test";
import type { ObservationSnapshot } from "@setpoint/protocol";
import { SetpointClient } from "../src/client.js";

describe("AccountApi.observation", () => {
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

	const view: ObservationSnapshot = {
		poi_id: "sol_station",
		system_id: "sol",
		tick: 3,
		nearby: [{ player_id: "p2", username: "Other", in_combat: false }],
		system: [],
		cloaked: [],
		unknownSignature: false,
		activeScan: true,
	};

	test("get() GETs /accounts/:id/observation", async () => {
		mockFetchSequence([{ status: 200, body: view }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").observation.get();

		expect(result).toEqual(view);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/observation");
		expect(fetchCalls[0]?.method).toBe("GET");
	});

	test("get() encodeURIComponent's the account id", async () => {
		mockFetchSequence([{ status: 200, body: view }]);
		const client = new SetpointClient();

		await client.account("Player One").observation.get();

		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player%20One/observation");
	});
});
