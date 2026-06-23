import { describe, expect, test } from "bun:test";
import { LoadAtStation } from "../../../src/dispatcher/compounds/load-at-station.js";
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

describe("LoadAtStation", () => {
	test("loads from personal storage", async () => {
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "ore", item_name: "Iron Ore", quantity: 50 }],
				}),
			withdrawFromStorage: async () => {
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, cargo_used: 50 },
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 50, size: 1 }],
				});
				return mockApiResponse({
					action: "withdraw",
					message: "Withdrawn",
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new LoadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			sourceType: "personal-storage",
			items: [{ itemId: "ore", quantity: 50 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("loads from faction storage", async () => {
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo, ship: currentState.ship }),
			viewFactionStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "ore", item_name: "Iron Ore", quantity: 50 }],
				}),
			withdrawFromFactionStorage: async () => {
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, cargo_used: 50 },
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 50, size: 1 }],
				});
				return mockApiResponse({
					action: "withdraw",
					message: "Withdrawn from faction storage",
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new LoadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			sourceType: "faction-storage",
			items: [{ itemId: "ore", quantity: 50 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("loads from market", async () => {
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						{
							item_id: "ore",
							item_name: "Iron Ore",
							best_buy: 0,
							best_sell: 10,
							buy_price: 0,
							buy_quantity: 0,
							sell_price: 10,
							sell_quantity: 200,
							buy_orders: [],
							sell_orders: [{ price_each: 10, quantity: 200 }],
						},
					],
				}),
			buy: async () => {
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, cargo_used: 50 },
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 50, size: 1 }],
				});
				return mockApiResponse({
					action: "buy",
					item: "Iron Ore",
					item_id: "ore",
					quantity: 50,
					total_cost: 500,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new LoadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			sourceType: "market",
			items: [{ itemId: "ore", maxPrice: 20, quantity: 50 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});
});
