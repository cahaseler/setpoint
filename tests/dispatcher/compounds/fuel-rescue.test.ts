import { describe, expect, test } from "bun:test";
import { FuelRescue } from "../../../src/dispatcher/compounds/fuel-rescue.js";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Rescuer", credits: 5000 },
		ship: {
			id: "s1",
			hull: 100,
			max_hull: 100,
			fuel: 100,
			max_fuel: 100,
			cargo_capacity: 100,
			cargo_used: 0,
		},
		location: {
			system_id: "sol",
			system_name: "Sol",
			poi_id: "sol-belt-1",
			poi_name: "Sol Belt",
		},
		cargo: [],
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

const NEARBY_WITH_TARGET = mockApiResponse({
	nearby: [{ username: "StrandedPilot", player_id: "p2", in_combat: false }],
	pirates: [],
	count: 1,
	pirate_count: 0,
	poi_id: "sol-belt-1",
});

const NEARBY_EMPTY = mockApiResponse({
	nearby: [],
	pirates: [],
	count: 0,
	pirate_count: 0,
	poi_id: "sol-belt-1",
});

describe("FuelRescue", () => {
	test("succeeds when already at POI and target is present", async () => {
		const state = makeState();
		let refueledTarget = "";
		const endpoints = createMockEndpoints({
			getNearby: async () => NEARBY_WITH_TARGET,
			refuelTarget: async (username: unknown) => {
				refueledTarget = username as string;
				return mockApiResponse({
					action: "refuel",
					source: "fuel_cell",
					fuel: 100,
					target_player_name: username as string,
					rescue_completed: true,
					rescue_reward: 50,
				});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new FuelRescue({
			systemId: "sol",
			poiId: "sol-belt-1",
			targetUsername: "StrandedPilot",
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(refueledTarget).toBe("StrandedPilot");
		expect(result.message).toContain("StrandedPilot");
	});

	test("fails when target player is not at POI", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			getNearby: async () => NEARBY_EMPTY,
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new FuelRescue({
			systemId: "sol",
			poiId: "sol-belt-1",
			targetUsername: "StrandedPilot",
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("StrandedPilot");
		expect(result.message).toContain("sol-belt-1");
	});

	test("username comparison is case-insensitive", async () => {
		const state = makeState();
		let refueled = false;
		const endpoints = createMockEndpoints({
			getNearby: async () =>
				mockApiResponse({
					nearby: [
						{
							username: "strandedpilot",
							player_id: "p2",
							in_combat: false,
						},
					],
					pirates: [],
					count: 1,
					pirate_count: 0,
					poi_id: "sol-belt-1",
				}),
			refuelTarget: async () => {
				refueled = true;
				return mockApiResponse({ action: "refuel", source: "fuel_cell", fuel: 100 });
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new FuelRescue({
			systemId: "sol",
			poiId: "sol-belt-1",
			targetUsername: "STRANDEDPILOT",
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(refueled).toBe(true);
	});

	test("navigates to system before checking POI", async () => {
		const state = makeState({
			location: {
				system_id: "other-system",
				system_name: "Other",
				poi_id: "other-poi",
				poi_name: "Other POI",
			},
		});
		let jumped = false;
		let refueled = false;
		const endpoints = createMockEndpoints({
			findRoute: async () =>
				mockApiResponse({
					found: true,
					route: [{ system_id: "sol" }],
					total_jumps: 1,
				}),
			jump: async (_id: unknown) => {
				jumped = true;
				return mockApiResponse({ action: "jump", destination: "sol" });
			},
			travel: async (_id: unknown) =>
				mockApiResponse({ action: "travel", destination: "sol-belt-1" }),
			getNearby: async () => NEARBY_WITH_TARGET,
			refuelTarget: async () => {
				refueled = true;
				return mockApiResponse({ action: "refuel", source: "fuel_cell", fuel: 100 });
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new FuelRescue({
			systemId: "sol",
			poiId: "sol-belt-1",
			targetUsername: "StrandedPilot",
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(jumped).toBe(true);
		expect(refueled).toBe(true);
	});

	test("fails if no route to target system", async () => {
		const state = makeState({
			location: { system_id: "other-system", system_name: "Other" },
		});
		const endpoints = createMockEndpoints({
			findRoute: async () =>
				mockApiResponse({ found: false, route: [], total_jumps: 0, message: "No route" }),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new FuelRescue({
			systemId: "sol",
			poiId: "sol-belt-1",
			targetUsername: "StrandedPilot",
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("No route");
	});
});
