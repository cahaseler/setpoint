import { afterEach, describe, expect, test } from "bun:test";
import type { RawEnvelope } from "@setpoint/protocol";
import type { JumpResponse, StateDelta, UndockResponse, ViewMarketResponse } from "@spacemolt/lib";
import { SetpointClient } from "../src/client.js";

// A mutation's raw structuredContent is the full state delta with its
// action-specific `details` narrowed to that action's response type — the
// same shape `MutationResult<TDetails>['delta']` resolves to.
type MutationDelta<TDetails> = Omit<StateDelta, "details"> & { details?: TDetails };

describe("AccountApi.raw", () => {
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

	const jumpEnvelope: RawEnvelope<MutationDelta<JumpResponse>> = {
		result: { moved: true },
		structuredContent: {
			details: {
				action: "jump",
				from_system: "alpha",
				system: "Sol",
				system_id: "sol",
				navigation_xp: 5,
			},
		},
		tick: 42,
		command: "jump",
	};

	test("raw.spacemolt.jump(params) POSTs /accounts/:id/raw with {toolGroup, action, params}", async () => {
		mockFetchSequence([{ status: 200, body: jumpEnvelope }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").raw.spacemolt.jump({ id: "sol" });

		expect(result).toEqual(jumpEnvelope);
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/raw");
		expect(fetchCalls[0]?.method).toBe("POST");
		expect(fetchCalls[0]?.body).toEqual({
			toolGroup: "spacemolt",
			action: "jump",
			params: { id: "sol" },
		});
	});

	test("raw.spacemolt_market.view_market(params) routes through the spacemolt_market group", async () => {
		const marketEnvelope: RawEnvelope<ViewMarketResponse> = { result: { orders: [] } };
		mockFetchSequence([{ status: 200, body: marketEnvelope }]);
		const client = new SetpointClient();

		const result = await client
			.account("Player1")
			.raw.spacemolt_market.view_market({ item_id: "x" });

		expect(result).toEqual(marketEnvelope);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/raw");
		expect(fetchCalls[0]?.method).toBe("POST");
		expect(fetchCalls[0]?.body).toEqual({
			toolGroup: "spacemolt_market",
			action: "view_market",
			params: { item_id: "x" },
		});
	});

	test("raw.spacemolt.undock() (no-arg action) sends params: undefined", async () => {
		const undockEnvelope: RawEnvelope<MutationDelta<UndockResponse>> = {
			result: {},
			tick: 1,
			command: "undock",
		};
		mockFetchSequence([{ status: 200, body: undockEnvelope }]);
		const client = new SetpointClient();

		const result = await client.account("Player1").raw.spacemolt.undock();

		expect(result).toEqual(undockEnvelope);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player1/raw");
		expect(fetchCalls[0]?.method).toBe("POST");
		// JSON.stringify drops keys with an `undefined` value, so the wire body
		// never carries a `params` key at all for a no-arg call.
		expect(fetchCalls[0]?.body).toEqual({ toolGroup: "spacemolt", action: "undock" });
		const bodyAsRecord = fetchCalls[0]?.body as Record<string, unknown>;
		expect("params" in bodyAsRecord).toBe(false);
	});

	test("raw encodeURIComponent's the account id", async () => {
		mockFetchSequence([{ status: 200, body: jumpEnvelope }]);
		const client = new SetpointClient();

		await client.account("Player One").raw.spacemolt.jump({ id: "sol" });

		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/accounts/Player%20One/raw");
	});
});
