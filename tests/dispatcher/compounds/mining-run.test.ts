import { describe, expect, test } from "bun:test";
import { MiningRun } from "../../../src/dispatcher/compounds/mining-run.js";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

const defaultShip = {
	id: "s1",
	hull: 100,
	max_hull: 100,
	fuel: 50,
	max_fuel: 50,
	cargo_capacity: 100,
	cargo_used: 0,
};

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
			system_id: "alpha",
			system_name: "Alpha",
			poi_id: "alpha_poi",
			poi_name: "Alpha Station",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("MiningRun", () => {
	test("full sequence from different system", async () => {
		let cargoUsed = 0;
		let currentState = makeState();

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
						poi_id: "belt_1",
						poi_name: "Asteroid Belt",
					},
				});
				return mockApiResponse({});
			},
			undock: async () => mockApiResponse({}),
			mine: async () => {
				cargoUsed += 50;
				currentState = makeState({
					...currentState,
					ship: { ...defaultShip, ...currentState.ship, cargo_used: cargoUsed },
				});
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new MiningRun({
			systemId: "sol",
			beltPoiId: "belt_1",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.steps.length).toBeGreaterThanOrEqual(4);
		expect(result.steps.map((s) => s.goalName)).toEqual([
			"navigate-to-system",
			"go-to-poi",
			"ensure-undocked",
			"mine-until-full",
		]);
	});

	test("travel failure stops before mining", async () => {
		const currentState = makeState();

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

		const goal = new MiningRun({
			systemId: "unreachable",
			beltPoiId: "belt_1",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		// Should not have a mine-until-full step
		expect(result.steps.every((s) => s.goalName !== "mine-until-full")).toBe(true);
	});

	test("already at belt skips travel", async () => {
		let cargoUsed = 0;
		let currentState = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "belt_1",
				poi_name: "Asteroid Belt",
			},
		});

		const endpoints = createMockEndpoints({
			undock: async () => mockApiResponse({}),
			mine: async () => {
				cargoUsed = 100;
				currentState = makeState({
					...currentState,
					ship: { ...defaultShip, ...currentState.ship, cargo_used: cargoUsed },
				});
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new MiningRun({
			systemId: "sol",
			beltPoiId: "belt_1",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// navigate-to-system and go-to-poi should be already satisfied
		expect(result.steps[0]?.result.alreadySatisfied).toBe(true);
		expect(result.steps[1]?.result.alreadySatisfied).toBe(true);
	});
});
