import { describe, expect, test } from "bun:test";
import { makeLibGoalContext } from "../../../src/dispatcher/lib-goal-context.js";
import { runExplorationLoop } from "../../../src/dispatcher/lib-loops/exploration-loop.js";
import { FakeLibGoalAccount, fakeMutationResult } from "../lib-fakes.js";

describe("runExplorationLoop", () => {
	test("navigates to the nearest unrecorded system, then stops at maxIterations", async () => {
		const account = new FakeLibGoalAccount(
			{
				location: { system_id: "sol", poi_id: "sol_station" },
				ship: { fuel: 100, max_fuel: 100, hull: 50, max_hull: 50 },
			},
			{
				intel_status: () => ({
					result: "",
					structuredContent: { coverage_pct: 0, intel_level: 2, pois_known: 0, systems_known: 0 },
				}),
				get_map: () => ({
					result: "",
					structuredContent: {
						total_count: 2,
						systems: [
							{ system_id: "sol", connections: ["alpha"], empire: "solarian" },
							{ system_id: "alpha", connections: ["sol"], empire: "solarian" },
						],
					},
				}),
				query_intel: () => ({
					result: "",
					structuredContent: { count: 0, current_tick: 1, entries: [] },
				}),
				find_route: () => ({
					result: "",
					structuredContent: {
						found: true,
						route: [{ system_id: "alpha", jumps: 1, name: "Alpha" }],
						total_jumps: 1,
						fuel_per_jump: 5,
						estimated_fuel: 5,
						fuel_available: 100,
						target_system: "alpha",
						cargo_used: 0,
						message: "",
					},
				}),
				jump: () => fakeMutationResult("jump"),
			},
		);

		const result = await runExplorationLoop(
			{
				systemId: "sol",
				stationPoiId: "sol_station",
				baseId: "sol_base",
				loopOptions: { maxIterations: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(account.calls.some((c) => c.action === "jump")).toBe(true);
	});

	test("fails upfront when the faction lacks a Level 2 Intel Center", async () => {
		const account = new FakeLibGoalAccount(
			{ location: { system_id: "sol", poi_id: "sol_station" } },
			{
				intel_status: () => ({
					result: "",
					structuredContent: { coverage_pct: 0, intel_level: 1, pois_known: 0, systems_known: 0 },
				}),
			},
		);

		const result = await runExplorationLoop(
			{
				systemId: "sol",
				stationPoiId: "sol_station",
				baseId: "sol_base",
				loopOptions: { maxIterations: 1, retryDelayMs: 1 },
			},
			makeLibGoalContext(account),
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("Level 2 Intel Center");
	});
});
