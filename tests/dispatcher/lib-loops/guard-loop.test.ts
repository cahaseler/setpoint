import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { runGuardLoop } from "../../../src/dispatcher/lib-loops/guard-loop.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

describe("runGuardLoop", () => {
	test("patrols and clears an already-clear POI for a bounded number of sweeps", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "guard_poi" },
				ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
			},
			{
				get_nearby: () => ({ result: "", structuredContent: { pirates: [] } }),
			},
		);

		const result = await runGuardLoop(
			{
				homeSystemId: "sol",
				homeStationPoiId: "sol_station",
				homeBaseId: "sol_base",
				guardSystemId: "sol",
				guardPoiId: "guard_poi",
				loopOptions: { maxIterations: 2, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
		expect(account.calls.some((c) => c.action === "get_nearby")).toBe(true);
	});

	test("stops after a consecutive failure when a damaged ship cannot route home", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "guard_poi" },
				ship: { fuel: 100, max_fuel: 100, hull: 10, max_hull: 50 },
			},
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const result = await runGuardLoop(
			{
				homeSystemId: "alpha",
				homeStationPoiId: "sol_station",
				homeBaseId: "sol_base",
				guardSystemId: "sol",
				guardPoiId: "guard_poi",
				loopOptions: { maxConsecutiveFailures: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("consecutive failure");
	});
});
