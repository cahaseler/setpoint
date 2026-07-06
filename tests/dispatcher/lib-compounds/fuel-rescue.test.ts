import { describe, expect, test } from "bun:test";
import { LibFuelRescue } from "../../../src/dispatcher/lib-compounds/fuel-rescue.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("LibFuelRescue", () => {
	test("refuels the target directly, without a get_nearby precondition", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "poi-1" } },
			{ refuel: () => fakeMutationResult("refuel") },
		);
		const result = await new LibFuelRescue({
			systemId: "sol",
			poiId: "poi-1",
			targetUsername: "Stranded",
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(result.message).toContain("Refueled Stranded");
		expect(account.calls.some((c) => c.action === "refuel")).toBe(true);
		expect(account.calls.some((c) => c.action === "get_nearby")).toBe(false);
	});

	test("refuels a target that get_nearby would have collapsed as offline", async () => {
		// Regression case: get_nearby folds offline players into offline_collapsed
		// once a POI is crowded, dropping a genuinely-present (but offline,
		// stranded-and-out-of-fuel) target out of the named nearby list. refuel()
		// itself doesn't care about get_nearby's visibility rules, so it must not
		// be gated on that check.
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "poi-1" } },
			{ refuel: () => fakeMutationResult("refuel") },
		);
		const result = await new LibFuelRescue({
			systemId: "sol",
			poiId: "poi-1",
			targetUsername: "Stranded",
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
	});

	test("fails with the game's own error when the target can't actually be refueled", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "poi-1" } },
			{
				refuel: () => {
					throw new Error("Target player Stranded is not at this location");
				},
			},
		);
		const result = await new LibFuelRescue({
			systemId: "sol",
			poiId: "poi-1",
			targetUsername: "Stranded",
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("Target player Stranded is not at this location");
	});

	test("retries once after a 'not at POI' rejection and succeeds", async () => {
		// Regression: refuel()'s own reachability check has been observed to
		// reject a target confirmed to be at the POI, with a manual retry
		// moments later succeeding — the server's own check can lag the
		// target's actual position. Must retry once before failing.
		let refuelCalls = 0;
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "poi-1" } },
			{
				refuel: () => {
					refuelCalls++;
					if (refuelCalls === 1) {
						throw new Error("Target player Stranded is not at POI poi-1");
					}
					return fakeMutationResult("refuel");
				},
			},
		);
		const result = await new LibFuelRescue(
			{ systemId: "sol", poiId: "poi-1", targetUsername: "Stranded" },
			5,
		).execute(makeLibGoalContext(account));
		expect(result.success).toBe(true);
		expect(refuelCalls).toBe(2);
	});

	test("fails if the retry also rejects with 'not at POI'", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "poi-1" } },
			{
				refuel: () => {
					throw new Error("Target player Stranded is not at POI poi-1");
				},
			},
		);
		const result = await new LibFuelRescue(
			{ systemId: "sol", poiId: "poi-1", targetUsername: "Stranded" },
			5,
		).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("is not at POI");
	});

	test("fails when navigation cannot find a route", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "poi-0" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);
		const result = await new LibFuelRescue({
			systemId: "alpha",
			poiId: "poi-1",
			targetUsername: "Stranded",
		}).execute(makeLibGoalContext(account));
		expect(result.success).toBe(false);
		expect(result.message).toContain("No route found");
	});
});
