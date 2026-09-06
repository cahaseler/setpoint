import { afterEach, describe, expect, test } from "bun:test";
import type { ReconcileResult } from "@setpoint/protocol";
import { SetpointClient } from "../src/client.js";

describe("AccountApi.fleet", () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls: Array<{ url: string; method: string | undefined; body: unknown }>;

	function parseBody(init: RequestInit | undefined): unknown {
		if (typeof init?.body !== "string") return undefined;
		return JSON.parse(init.body);
	}

	function mockFetch(status: number, body: unknown): void {
		fetchCalls = [];
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: url.toString(), method: init?.method, body: parseBody(init) });
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as typeof fetch;
	}

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	const result: ReconcileResult = {
		success: true,
		message: "2 of 2 updated",
		alreadySatisfied: false,
		ticksUsed: 5,
		subjects: [
			{ id: "alpha", kind: "member", ok: true, action: "created" },
			{ id: "beta", kind: "member", ok: true, action: "created" },
		],
		summary: { total: 2, changed: 2, unchanged: 0, failed: 0 },
	};

	test("ensure() POSTs the member list to /accounts/:id/fleet", async () => {
		mockFetch(200, result);
		const sp = new SetpointClient({ baseUrl: "http://localhost:7580" });

		const got = await sp.account("leader").fleet.ensure(["alpha", "beta"]);

		expect(fetchCalls[0]?.url).toBe("http://localhost:7580/accounts/leader/fleet");
		expect(fetchCalls[0]?.method).toBe("POST");
		expect(fetchCalls[0]?.body).toEqual({ members: ["alpha", "beta"] });
		expect(got.summary.changed).toBe(2);
	});

	test("an empty member list is how a fleet is disbanded", async () => {
		mockFetch(200, {
			...result,
			subjects: [],
			summary: { total: 0, changed: 0, unchanged: 0, failed: 0 },
		});
		const sp = new SetpointClient({ baseUrl: "http://localhost:7580" });

		await sp.account("leader").fleet.ensure([]);

		expect(fetchCalls[0]?.body).toEqual({ members: [] });
	});

	test("a busy member comes back as a failed subject with the state observed", async () => {
		// The daemon never preempts: a member mid-loop is reported, not taken.
		const busy: ReconcileResult = {
			success: false,
			message: "1 of 1 failed",
			alreadySatisfied: false,
			ticksUsed: 0,
			subjects: [
				{
					id: "miner",
					kind: "member",
					ok: false,
					action: "none",
					message: "busy:loop:mining",
					before: { inFleet: false, systemId: "sol", poiId: "belt-1", inTransit: false },
				},
			],
			summary: { total: 1, changed: 0, unchanged: 1, failed: 1 },
		};
		mockFetch(200, busy);
		const sp = new SetpointClient({ baseUrl: "http://localhost:7580" });

		const got = await sp.account("leader").fleet.ensure(["miner"]);

		expect(got.success).toBe(false);
		const [subject] = got.subjects;
		expect(subject?.ok).toBe(false);
		expect(subject?.message).toBe("busy:loop:mining");
		expect(subject?.before).toMatchObject({ systemId: "sol", poiId: "belt-1" });
	});

	test("encodes an id that needs escaping", async () => {
		mockFetch(200, result);
		const sp = new SetpointClient({ baseUrl: "http://localhost:7580" });
		await sp.account("ILC Voyager").fleet.ensure([]);
		expect(fetchCalls[0]?.url).toContain("/accounts/ILC%20Voyager/fleet");
	});
});
