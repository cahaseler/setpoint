import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { BuyItems } from "../../../src/dispatcher/primitives/index.js";
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
			cargo_used: 10,
		},
		cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 10, size: 1 }],
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

const marketResponse = mockApiResponse({
	action: "view_market",
	base: "Test Station",
	items: [
		{
			item_id: "ore",
			item_name: "Iron Ore",
			best_buy: 10,
			best_sell: 5,
			buy_price: 10,
			buy_quantity: 100,
			sell_price: 5,
			sell_quantity: 50,
			buy_orders: [],
			sell_orders: [{ price_each: 5, quantity: 50 }],
		},
	],
});

const buyResponse = mockApiResponse({
	total_cost: 250,
	quantity: 50,
	fills: [],
	unfilled: 0,
	delivered_to_cargo: 50,
	delivered_to_storage: 0,
});

describe("BuyItems", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new BuyItems({ items: [{ itemId: "ore", maxPrice: 10 }] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("must be docked");
	});

	test("returns already satisfied when items list is empty", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new BuyItems({ items: [] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("returns already satisfied when cargo is full", async () => {
		const state = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 100,
			},
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new BuyItems({ items: [{ itemId: "ore", maxPrice: 10 }] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("buys items under max price from market sell orders", async () => {
		const state = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 0,
			},
		});

		let boughtItemId = "";
		let boughtQuantity = 0;
		const endpoints = createMockEndpoints({
			viewMarket: async () => marketResponse,
			buy: async (itemId: unknown, quantity: unknown) => {
				boughtItemId = itemId as string;
				boughtQuantity = quantity as number;
				return buyResponse;
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new BuyItems({ items: [{ itemId: "ore", maxPrice: 10 }] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(boughtItemId).toBe("ore");
		expect(boughtQuantity).toBe(50);
	});

	test("respects maxQuantity limit", async () => {
		const state = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 0,
			},
		});

		let boughtQuantity = 0;
		const endpoints = createMockEndpoints({
			viewMarket: async () => marketResponse,
			buy: async (_itemId: unknown, quantity: unknown) => {
				boughtQuantity = quantity as number;
				return mockApiResponse({
					total_cost: 50,
					quantity: 10,
					fills: [],
					unfilled: 0,
					delivered_to_cargo: 10,
					delivered_to_storage: 0,
				});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new BuyItems({ items: [{ itemId: "ore", maxPrice: 10, maxQuantity: 10 }] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// maxQuantity of 10, sell orders have 50 — should buy only 10
		expect(boughtQuantity).toBe(10);
	});

	test("skips items with no sell orders under max price", async () => {
		const state = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 0,
			},
		});

		let buyCalled = false;
		const endpoints = createMockEndpoints({
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Test Station",
					items: [
						{
							item_id: "ore",
							item_name: "Iron Ore",
							best_buy: 10,
							best_sell: 50,
							buy_price: 10,
							buy_quantity: 100,
							sell_price: 50,
							sell_quantity: 5,
							buy_orders: [],
							sell_orders: [{ price_each: 50, quantity: 5 }],
						},
					],
				}),
			buy: async () => {
				buyCalled = true;
				return buyResponse;
			},
		});
		const ctx: GoalContext = { endpoints, state };

		// maxPrice is 10, but sell orders are at 50 — should skip
		const goal = new BuyItems({ items: [{ itemId: "ore", maxPrice: 10 }] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(buyCalled).toBe(false);
	});

	test("stops buying when the abort signal fires between items", async () => {
		const controller = new AbortController();
		const state = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 1000,
				cargo_used: 0,
			},
		});

		const boughtItemIds: string[] = [];
		const endpoints = createMockEndpoints({
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Test Station",
					items: [
						{
							item_id: "ore",
							item_name: "Iron Ore",
							best_buy: 10,
							best_sell: 5,
							buy_price: 10,
							buy_quantity: 100,
							sell_price: 5,
							sell_quantity: 50,
							buy_orders: [],
							sell_orders: [{ price_each: 5, quantity: 50 }],
						},
						{
							item_id: "gem",
							item_name: "Gem",
							best_buy: 10,
							best_sell: 5,
							buy_price: 10,
							buy_quantity: 100,
							sell_price: 5,
							sell_quantity: 50,
							buy_orders: [],
							sell_orders: [{ price_each: 5, quantity: 50 }],
						},
					],
				}),
			buy: async (itemId: unknown, quantity: unknown) => {
				boughtItemIds.push(itemId as string);
				// Force abort lands while the first buy is in flight — the second
				// item must not be processed.
				controller.abort();
				return mockApiResponse({
					total_cost: 250,
					quantity: quantity as number,
					fills: [],
					unfilled: 0,
					delivered_to_cargo: quantity as number,
					delivered_to_storage: 0,
				});
			},
		});
		const ctx: GoalContext = { endpoints, state, signal: controller.signal };

		const goal = new BuyItems({
			items: [
				{ itemId: "ore", maxPrice: 10 },
				{ itemId: "gem", maxPrice: 10 },
			],
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(boughtItemIds).toEqual(["ore"]);
	});

	test("returns already satisfied when no items match prices", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Test Station",
					items: [],
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new BuyItems({ items: [{ itemId: "rare_gem", maxPrice: 100 }] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});
});
