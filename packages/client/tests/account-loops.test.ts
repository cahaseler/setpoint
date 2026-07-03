import { afterEach, describe, expect, test } from "bun:test";
import type { LoopStatus } from "@setpoint/protocol";
import { SetpointClient } from "../src/client.js";

describe("AccountApi.loop", () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls: Array<{ url: string; method: string | undefined; body: unknown }>;

	function parseBody(init: RequestInit | undefined): unknown {
		if (typeof init?.body !== "string") return undefined;
		return JSON.parse(init.body);
	}

	/** Queues a fixed sequence of responses, one per successive fetch call. */
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

	const miningLoopStatus: LoopStatus = {
		type: "mining",
		startedAt: new Date().toISOString(),
		running: true,
		options: {
			miningSystemId: "sol",
			beltPoiId: "belt-1",
			sellSystemId: "sol",
			sellStationPoiId: "station-1",
			sellBaseId: "base-1",
		},
	};

	test("start() POSTs /accounts/:id/loop with {type, options} and returns the LoopStatus", async () => {
		mockFetchSequence([{ status: 201, body: miningLoopStatus }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").loop.start("mining", {
			miningSystemId: "sol",
			beltPoiId: "belt-1",
			sellSystemId: "sol",
			sellStationPoiId: "station-1",
			sellBaseId: "base-1",
		});

		expect(result).toEqual(miningLoopStatus);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/loop");
		expect(fetchCalls[0]?.method).toBe("POST");
		expect(fetchCalls[0]?.body).toEqual({
			type: "mining",
			options: {
				miningSystemId: "sol",
				beltPoiId: "belt-1",
				sellSystemId: "sol",
				sellStationPoiId: "station-1",
				sellBaseId: "base-1",
			},
		});
	});

	test("get() GETs /accounts/:id/loop and returns the LoopStatus", async () => {
		mockFetchSequence([{ status: 200, body: miningLoopStatus }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").loop.get();

		expect(result).toEqual(miningLoopStatus);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/loop");
		expect(fetchCalls[0]?.method).toBe("GET");
		expect(fetchCalls[0]?.body).toBeUndefined();
	});

	test("get() returns {running: false} when no loop has ever run", async () => {
		mockFetchSequence([{ status: 200, body: { running: false } }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").loop.get();

		expect(result).toEqual({ running: false });
	});

	test("patch() PATCHes /accounts/:id/loop with the FLAT partial (not wrapped in options)", async () => {
		mockFetchSequence([
			{ status: 200, body: { ...miningLoopStatus, options: { fullThreshold: 0.9 } } },
		]);
		const client = new SetpointClient();

		const result = await client.account("Player1").loop.patch({ fullThreshold: 0.9 });

		expect(result).toEqual({ ...miningLoopStatus, options: { fullThreshold: 0.9 } });
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/loop");
		expect(fetchCalls[0]?.method).toBe("PATCH");
		expect(fetchCalls[0]?.body).toEqual({ fullThreshold: 0.9 });
		// Assert it is NOT wrapped in an "options" key.
		expect(fetchCalls[0]?.body).not.toHaveProperty("options");
	});

	test("stop() DELETEs /accounts/:id/loop and returns {message}", async () => {
		mockFetchSequence([{ status: 200, body: { message: "Loop stop signal sent" } }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").loop.stop();

		expect(result).toEqual({ message: "Loop stop signal sent" });
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/loop");
		expect(fetchCalls[0]?.method).toBe("DELETE");
	});

	test("start() rejects mistyped options at compile time", async () => {
		mockFetchSequence([{ status: 201, body: miningLoopStatus }]);
		const client = new SetpointClient();

		// @ts-expect-error — missing required fields and "wrong" is not a valid option for mining
		await client.account("Player1").loop.start("mining", { wrong: 1 });
	});
});
