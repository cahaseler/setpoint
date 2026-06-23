import { describe, expect, test } from "bun:test";
import { EnhancedMiningRun } from "../../../src/dispatcher/compounds/enhanced-mining-run.js";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 1000 },
		ship: {
			id: "s1",
			hull: 100,
			max_hull: 100,
			fuel: 50,
			max_fuel: 50,
			cargo_capacity: 100,
			cargo_used: 0,
		},
		cargo: [],
		location: {
			system_id: "sol",
			system_name: "Sol",
			poi_id: "belt_1",
			poi_name: "Asteroid Belt",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("EnhancedMiningRun", () => {
	test("travels to belt and mines with jettison", async () => {
		let mineCount = 0;
		let jettisonCalls = 0;
		let hasStone = true;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			findRoute: async () =>
				mockApiResponse({
					found: true,
					route: [],
					total_jumps: 0,
					message: "Already in system",
				}),
			undock: async () => {
				const loc = currentState.location;
				currentState = makeState({
					...currentState,
					location: {
						system_id: loc?.system_id ?? "sol",
						system_name: loc?.system_name ?? "Sol",
						...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
						...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
					},
				});
				return mockApiResponse({});
			},
			mine: async () => {
				mineCount++;
				if (hasStone) {
					currentState = makeState({
						ship: {
							id: "s1",
							hull: 100,
							max_hull: 100,
							fuel: 50,
							max_fuel: 50,
							cargo_capacity: 100,
							cargo_used: 100,
						},
						cargo: [
							{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 70, size: 1 },
							{ item_id: "stone", item_name: "Stone", quantity: 30, size: 1 },
						],
					});
				} else {
					currentState = makeState({
						ship: {
							id: "s1",
							hull: 100,
							max_hull: 100,
							fuel: 50,
							max_fuel: 50,
							cargo_capacity: 100,
							cargo_used: 100,
						},
						cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 100, size: 1 }],
					});
				}
				return mockApiResponse({});
			},
			jettison: async () => {
				jettisonCalls++;
				hasStone = false;
				currentState = makeState({
					ship: {
						id: "s1",
						hull: 100,
						max_hull: 100,
						fuel: 50,
						max_fuel: 50,
						cargo_capacity: 100,
						cargo_used: 70,
					},
					cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 70, size: 1 }],
				});
				return mockApiResponse({
					item_id: "stone",
					item_name: "Stone",
					quantity: 30,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnhancedMiningRun({
			systemId: "sol",
			beltPoiId: "belt_1",
			junkItemIds: ["stone"],
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(mineCount).toBe(2);
		expect(jettisonCalls).toBe(1);
		expect(result.steps.length).toBeGreaterThan(0);
	});

	test("fails when travel fails", async () => {
		const currentState = makeState({
			location: {
				system_id: "alpha",
				system_name: "Alpha Centauri",
			},
		});

		const endpoints = createMockEndpoints({
			findRoute: async () =>
				mockApiResponse({
					found: false,
					route: [],
					total_jumps: 0,
					message: "No route found",
				}),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnhancedMiningRun({
			systemId: "sol",
			beltPoiId: "belt_1",
			junkItemIds: ["stone"],
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
	});
});
