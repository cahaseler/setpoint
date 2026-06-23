import { describe, expect, test } from "bun:test";
import { PrepareAtStation } from "../../../src/dispatcher/compounds/index.js";
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
			poi_id: "sol_station",
			poi_name: "Sol Central",
			docked_at: "sol_base",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("PrepareAtStation", () => {
	test("all steps already satisfied when at target station", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new PrepareAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
		expect(result.steps).toHaveLength(5);
		expect(result.steps.every((s) => s.result.alreadySatisfied)).toBe(true);
	});

	test("skips refuel and repair when disabled", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new PrepareAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			refuel: false,
			repair: false,
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.steps).toHaveLength(3);
		expect(result.steps.map((s) => s.goalName)).toEqual([
			"navigate-to-system",
			"go-to-poi",
			"dock-at",
		]);
	});

	test("executes full sequence from a different system", async () => {
		// Start in a different system, undocked
		let currentState = makeState({
			location: {
				system_id: "alpha",
				system_name: "Alpha",
				poi_id: "alpha_poi",
			},
			ship: {
				id: "s1",
				hull: 80,
				max_hull: 100,
				fuel: 30,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 0,
			},
		});

		const endpoints = createMockEndpoints({
			findRoute: async () =>
				mockApiResponse({
					found: true,
					route: [{ system_id: "sol" }],
					total_jumps: 1,
					message: "Route found",
				}),
			jump: async () => {
				currentState = makeState({
					...currentState,
					location: { system_id: "sol", system_name: "Sol" },
				});
				return mockApiResponse({});
			},
			travel: async () => {
				currentState = makeState({
					...currentState,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "sol_station",
						poi_name: "Sol Central",
					},
				});
				return mockApiResponse({});
			},
			dock: async () => {
				currentState = makeState({
					...currentState,
					location: {
						...currentState.location,
						docked_at: "sol_base",
					},
				});
				return mockApiResponse({});
			},
			refuel: async () => {
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, fuel: 50 },
				});
				return mockApiResponse({});
			},
			repair: async () => {
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, hull: 100 },
				});
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new PrepareAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(5);
		expect(result.steps).toHaveLength(5);
		expect(result.steps.map((s) => s.goalName)).toEqual([
			"navigate-to-system",
			"go-to-poi",
			"dock-at",
			"ensure-fueled",
			"ensure-repaired",
		]);
	});

	test("uses navigate-via-route when an explicit route is provided", async () => {
		const jumps: string[] = [];
		let position = "alpha";
		let currentState = makeState({
			location: { system_id: "alpha", system_name: "Alpha", poi_id: "alpha_poi" },
		});

		const endpoints = createMockEndpoints({
			findRoute: async () =>
				mockApiResponse({
					found: true,
					route: [],
					total_jumps: 0,
					message: "Route found",
					fuel_per_jump: 1,
					estimated_fuel: 0,
					fuel_available: 100,
				}),
			jump: async (systemId: unknown) => {
				jumps.push(systemId as string);
				position = systemId as string;
				currentState = makeState({
					...currentState,
					location: { system_id: position, system_name: position },
				});
				return mockApiResponse({});
			},
			travel: async () => {
				currentState = makeState({
					...currentState,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "sol_station",
						poi_name: "Sol Central",
					},
				});
				return mockApiResponse({});
			},
			dock: async () => {
				currentState = makeState({
					...currentState,
					location: { ...currentState.location, docked_at: "sol_base" },
				});
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new PrepareAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			refuel: false,
			repair: false,
			route: ["backwater_a", "backwater_b", "sol"],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// The explicit route was followed hop-by-hop, not re-planned.
		expect(jumps).toEqual(["backwater_a", "backwater_b", "sol"]);
		expect(result.steps[0]?.goalName).toBe("navigate-via-route");
	});

	test("fails upfront when the explicit route does not end at the target system", async () => {
		const goal = new PrepareAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			route: ["backwater_a", "backwater_b"],
		});
		const ctx: GoalContext = { endpoints: createMockEndpoints(), state: makeState() };

		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain('route must end at "sol"');
	});

	test("stops on failure mid-sequence", async () => {
		// At the right system and POI but dock fails
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol_station",
				poi_name: "Sol Central",
			},
		});

		const endpoints = createMockEndpoints({
			dock: async () => {
				throw new Error("Docking bay full");
			},
		});

		const ctx: GoalContext = { endpoints, state };

		const goal = new PrepareAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
		});

		// The dock endpoint throws, which should propagate as a failure
		await expect(goal.execute(ctx)).rejects.toThrow("Docking bay full");
	});

	test("partial satisfaction — already in system but needs to dock", async () => {
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "other_poi",
				poi_name: "Other POI",
			},
		});

		let currentState = state;
		const endpoints = createMockEndpoints({
			travel: async () => {
				currentState = makeState({
					...currentState,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "sol_station",
						poi_name: "Sol Central",
					},
				});
				return mockApiResponse({});
			},
			dock: async () => {
				currentState = makeState({
					...currentState,
					location: { ...currentState.location, docked_at: "sol_base" },
				});
				return mockApiResponse({});
			},
			refuel: async () => mockApiResponse({}),
			repair: async () => mockApiResponse({}),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new PrepareAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			refuel: false,
			repair: false,
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// navigate-to-system already satisfied, go-to-poi and dock-at used ticks
		expect(result.steps[0]?.result.alreadySatisfied).toBe(true);
		expect(result.steps[1]?.result.ticksUsed).toBe(1);
		expect(result.steps[2]?.result.ticksUsed).toBe(1);
		expect(result.ticksUsed).toBe(2);
	});
});
