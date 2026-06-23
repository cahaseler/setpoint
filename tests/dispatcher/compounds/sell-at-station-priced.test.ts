import { describe, expect, test } from "bun:test";
import { SellAtStationPriced } from "../../../src/dispatcher/compounds/sell-at-station-priced.js";
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

describe("SellAtStationPriced", () => {
	test("already at station — lists cargo for sale", async () => {
		let currentState = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 30,
			},
			cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 30, size: 1 }],
		});

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			createSellOrder: async () => {
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, cargo_used: 0 },
					cargo: [],
				});
				return mockApiResponse({
					action: "create_sell_order",
					message: "Order created",
					quantity_filled: 30,
					quantity_listed: 0,
					total_earned: 300,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new SellAtStationPriced({
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "ore", minPrice: 10 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("already at station with empty cargo — all satisfied", async () => {
		const currentState = makeState({ cargo: [] });

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new SellAtStationPriced({
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "ore", minPrice: 10 }],
		});

		const result = await goal.execute(ctx);

		// PrepareAtStation satisfied, ListCargoForSale satisfied (no cargo)
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("from different location — full sequence", async () => {
		let currentState = makeState({
			location: {
				system_id: "alpha",
				system_name: "Alpha",
				poi_id: "alpha_poi",
			},
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 50,
			},
			cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 50, size: 1 }],
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
					location: { ...currentState.location, docked_at: "sol_base" },
				});
				return mockApiResponse({});
			},
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			createSellOrder: async () =>
				mockApiResponse({
					action: "create_sell_order",
					message: "Order created",
					quantity_filled: 50,
					quantity_listed: 0,
					total_earned: 500,
				}),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new SellAtStationPriced({
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "ore", minPrice: 10 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});
});
