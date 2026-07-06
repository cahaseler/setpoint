import { describe, expect, test } from "bun:test";
import { ConnectionClosedError, SpacemoltError } from "@spacemolt/lib";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibGoToPoi } from "../../../src/dispatcher/lib-primitives/go-to-poi.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibGoToPoi", () => {
	test("already satisfied when at target POI", async () => {
		const account = new FakeLibGoalAccount({ location: { system_id: "sol", poi_id: "belt-1" } });
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
		expect(account.calls).toHaveLength(0);
	});

	test("travels to POI and succeeds", async () => {
		const account = new FakeLibGoalAccount({ location: { system_id: "sol", poi_id: "station-1" } });
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(account.calls[0]).toEqual({ action: "travel", params: { id: "belt-1" } });
	});

	test("force-refreshes when location unknown, then travels", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		account.refreshReturns = { location: { system_id: "sol", poi_id: "station-1" } };
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(account.refreshCalls).toBe(1);
		expect(result.success).toBe(true);
	});

	test("fails when location still unknown after waiting it out", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		account.refreshReturns = { location: {} };
		const result = await new LibGoToPoi("belt-1", { maxWaitMs: 20, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("current location unknown");
	});

	test("waits out an unresolved location, then travels once it resolves", async () => {
		let calls = 0;
		const account = new FakeLibGoalAccount({ location: {} });
		account.refresh = () => {
			calls++;
			if (calls >= 2) {
				account.setState({ location: { system_id: "sol", poi_id: "station-1" } });
			}
			return Promise.resolve(account.state);
		};
		const result = await new LibGoToPoi("belt-1", { maxWaitMs: 1000, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(true);
		expect(calls).toBeGreaterThanOrEqual(2);
	});

	test("retries once on SpacemoltError then succeeds", async () => {
		let calls = 0;
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "station-1" } },
			{
				travel: () => {
					calls++;
					if (calls === 1) throw new SpacemoltError("in_transit", "busy");
					return fakeMutationResult("travel");
				},
			},
		);
		account.refreshReturns = { location: { system_id: "sol", poi_id: "station-1" } };
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(calls).toBe(2);
	});

	test("returns failed (does not throw) when retry also fails", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "station-1" } },
			{
				travel: () => {
					throw new ConnectionClosedError("closed");
				},
			},
		);
		account.refreshReturns = { location: { system_id: "sol", poi_id: "station-1" } };
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("failed");
	});

	test("waits out in_transit even when system_id/poi_id still read as stale values", async () => {
		let calls = 0;
		const account = new FakeLibGoalAccount({
			location: { system_id: "sol", poi_id: "station-1", in_transit: true },
		});
		account.refresh = () => {
			calls++;
			if (calls >= 2) {
				account.setState({
					location: { system_id: "sol", poi_id: "belt-1", in_transit: false },
				});
			}
			return Promise.resolve(account.state);
		};
		const result = await new LibGoToPoi("belt-1", { maxWaitMs: 1000, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.alreadySatisfied).toBe(true);
		expect(calls).toBeGreaterThanOrEqual(2);
	});

	test("fails when still in_transit after waiting it out, even with a defined location", async () => {
		const account = new FakeLibGoalAccount({
			location: { system_id: "sol", poi_id: "station-1", in_transit: true },
		});
		const result = await new LibGoToPoi("belt-1", { maxWaitMs: 20, pollIntervalMs: 5 }).execute(
			makeLibGoalContext(account),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain("mid-transit");
	});

	test("already satisfied if refresh after error shows we arrived", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "station-1" } },
			{
				travel: () => {
					throw new SpacemoltError("in_transit", "busy");
				},
			},
		);
		account.refreshReturns = { location: { system_id: "sol", poi_id: "belt-1" } };
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(result.alreadySatisfied).toBe(true);
	});
});
