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

	test("fails when location still unknown after refresh", async () => {
		const account = new FakeLibGoalAccount({ location: {} });
		account.refreshReturns = { location: {} };
		const result = await new LibGoToPoi("belt-1").execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("current location unknown");
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
