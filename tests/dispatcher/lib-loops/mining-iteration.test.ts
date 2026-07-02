import { describe, expect, test } from "bun:test";
import type { GoalResult } from "../../../src/dispatcher/goals.js";
import { succeeded } from "../../../src/dispatcher/goals.js";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import type { LibGoal, LibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { LibMiningIteration } from "../../../src/dispatcher/lib-loops/mining-iteration.js";
import { FakeLibGoalAccount } from "../lib-fakes.js";

/** A run-goal double that records whether it executed. */
function runGoalDouble(): { goal: LibGoal; ranCount: () => number } {
	let ran = 0;
	return {
		goal: {
			name: "run-goal",
			execute: async (_ctx: LibGoalContext): Promise<GoalResult> => {
				ran++;
				return succeeded("mined", 2);
			},
		},
		ranCount: () => ran,
	};
}

const sellOptions = { systemId: "sol", stationPoiId: "sol_station", baseId: "sol_base" };
const sellPrepareOptions = { systemId: "sol", poiId: "sol_station", baseId: "sol_base" };

describe("LibMiningIteration", () => {
	test("mining phase — enough fuel runs the run-goal then sells at station", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "sol_station", docked_at: "sol_base" },
				ship: {
					fuel: 100,
					max_fuel: 100,
					hull: 50,
					max_hull: 50,
					cargo_capacity: 100,
					cargo_used: 0,
				},
				cargo: [],
			},
			{
				find_route: () => ({
					result: "",
					structuredContent: {
						found: true,
						route: [{ system_id: "sol" }],
						total_jumps: 1,
						fuel_per_jump: 5,
						estimated_fuel: 5,
						fuel_available: 100,
					},
				}),
			},
		);

		const { goal, ranCount } = runGoalDouble();
		const result = await new LibMiningIteration({
			iterationName: "mining-iteration",
			miningPoiId: "belt_1",
			runGoal: goal,
			sellOptions,
			sellPrepareOptions,
			depletedPhase: "mining",
			minFuelReserve: 0,
		}).execute(makeLibGoalContext(account));

		expect(ranCount()).toBe(1);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThanOrEqual(2);
	});

	test("selling phase — depleted resources skip the run-goal and fail if not dockable", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "p" } },
			{
				find_route: () => ({ result: "", structuredContent: { found: false, message: "no path" } }),
			},
		);

		const { goal, ranCount } = runGoalDouble();
		const result = await new LibMiningIteration({
			iterationName: "mining-iteration",
			miningPoiId: "belt_1",
			runGoal: goal,
			sellOptions: { systemId: "alpha", stationPoiId: "sol_station", baseId: "sol_base" },
			sellPrepareOptions,
			depletedPhase: "selling",
			minFuelReserve: 0,
		}).execute(makeLibGoalContext(account));

		expect(ranCount()).toBe(0);
		expect(result.success).toBe(false);
	});
});
