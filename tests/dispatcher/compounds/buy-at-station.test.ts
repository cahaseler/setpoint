import { describe, expect, test } from "bun:test";
import { BuyAtStation } from "../../../src/dispatcher/compounds/buy-at-station.js";
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

describe("BuyAtStation", () => {
	test("already at station — buys items from market", async () => {
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						{
							item_id: "fuel_cell",
							item_name: "Fuel Cell",
							best_buy: 0,
							best_sell: 50,
							buy_price: 0,
							buy_quantity: 0,
							sell_price: 50,
							sell_quantity: 500,
							buy_orders: [],
							sell_orders: [{ price_each: 50, quantity: 500 }],
						},
					],
				}),
			buy: async (_itemId, _quantity) => {
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, cargo_used: 10 },
					cargo: [{ item_id: "fuel_cell", item_name: "Fuel Cell", quantity: 10, size: 1 }],
				});
				return mockApiResponse({
					action: "buy",
					item: "Fuel Cell",
					item_id: "fuel_cell",
					quantity: 10,
					total_cost: 500,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new BuyAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "fuel_cell", maxPrice: 100 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// PrepareAtStation steps should all be satisfied, BuyItems uses 1 tick
		expect(result.steps.length).toBeGreaterThanOrEqual(2);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("already at station with no matching items — still succeeds", async () => {
		const currentState = makeState();

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [],
				}),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new BuyAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "fuel_cell", maxPrice: 10 }],
		});

		const result = await goal.execute(ctx);

		// BuyItems returns alreadySatisfied when nothing is available at price
		expect(result.success).toBe(true);
	});

	test("from different location — full sequence", async () => {
		let currentState = makeState({
			location: {
				system_id: "alpha",
				system_name: "Alpha",
				poi_id: "alpha_poi",
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
					location: { ...currentState.location, docked_at: "sol_base" },
				});
				return mockApiResponse({});
			},
			refuel: async () => mockApiResponse({}),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						{
							item_id: "fuel_cell",
							item_name: "Fuel Cell",
							best_buy: 0,
							best_sell: 50,
							buy_price: 0,
							buy_quantity: 0,
							sell_price: 50,
							sell_quantity: 200,
							buy_orders: [],
							sell_orders: [{ price_each: 50, quantity: 200 }],
						},
					],
				}),
			buy: async () =>
				mockApiResponse({
					action: "buy",
					item: "Fuel Cell",
					item_id: "fuel_cell",
					quantity: 20,
					total_cost: 1000,
				}),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new BuyAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			items: [{ itemId: "fuel_cell", maxPrice: 100 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});
});
