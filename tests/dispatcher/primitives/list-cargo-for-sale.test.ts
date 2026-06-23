import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { ListCargoForSale } from "../../../src/dispatcher/primitives/index.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

const DEFAULT_CARGO = [{ item_id: "ore", name: "Iron Ore", quantity: 10, size: 1 }];

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
		cargo: DEFAULT_CARGO,
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

describe("ListCargoForSale", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new ListCargoForSale({ items: [{ itemId: "ore", minPrice: 10 }] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("must be docked");
	});

	test("returns already satisfied when cargo is empty", async () => {
		const state = makeState({ cargo: [] });
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new ListCargoForSale({ items: [{ itemId: "ore", minPrice: 10 }] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("lists matching cargo items for sale", async () => {
		const state = makeState();

		const listed: Array<{ itemId: string; quantity: number; price: number }> = [];
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: DEFAULT_CARGO }),
			createSellOrder: async (itemId: unknown, quantity: unknown, price: unknown) => {
				listed.push({
					itemId: itemId as string,
					quantity: quantity as number,
					price: price as number,
				});
				return mockApiResponse({
					action: "create_sell_order",
					item: "Iron Ore",
					item_id: "ore",
					quantity: 10,
					price_each: 15,
					quantity_filled: 0,
					quantity_listed: 10,
					total_earned: 0,
					from_cargo: 10,
					from_storage: 0,
				});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new ListCargoForSale({ items: [{ itemId: "ore", minPrice: 15 }] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toEqual({ itemId: "ore", quantity: 10, price: 15 });
	});

	test("skips cargo items not in sell list", async () => {
		const mixedCargo = [
			{ item_id: "ore", name: "Iron Ore", quantity: 10, size: 1 },
			{ item_id: "gems", name: "Gems", quantity: 5, size: 1 },
		];
		const state = makeState({ cargo: mixedCargo });

		const listed: string[] = [];
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: mixedCargo }),
			createSellOrder: async (itemId: unknown) => {
				listed.push(itemId as string);
				return mockApiResponse({
					action: "create_sell_order",
					item: "Iron Ore",
					item_id: "ore",
					quantity: 10,
					price_each: 15,
					quantity_filled: 0,
					quantity_listed: 10,
					total_earned: 0,
					from_cargo: 10,
					from_storage: 0,
				});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		// Only ore is in the sell list, gems should be skipped
		const goal = new ListCargoForSale({ items: [{ itemId: "ore", minPrice: 15 }] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(listed).toEqual(["ore"]);
	});

	test("stops listing when the abort signal fires between items", async () => {
		const controller = new AbortController();
		const twoItemCargo = [
			{ item_id: "ore", name: "Iron Ore", quantity: 10, size: 1 },
			{ item_id: "gems", name: "Gems", quantity: 5, size: 1 },
		];
		const state = makeState({ cargo: twoItemCargo });

		const listed: string[] = [];
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: twoItemCargo }),
			createSellOrder: async (itemId: unknown) => {
				listed.push(itemId as string);
				// Force abort lands while the first listing is in flight — the
				// second item must not be processed.
				controller.abort();
				return mockApiResponse({
					action: "create_sell_order",
					item: "Iron Ore",
					item_id: "ore",
					quantity: 10,
					price_each: 15,
					quantity_filled: 0,
					quantity_listed: 10,
					total_earned: 0,
					from_cargo: 10,
					from_storage: 0,
				});
			},
		});
		const ctx: GoalContext = { endpoints, state, signal: controller.signal };

		const goal = new ListCargoForSale({
			items: [
				{ itemId: "ore", minPrice: 15 },
				{ itemId: "gems", minPrice: 100 },
			],
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(listed).toEqual(["ore"]);
	});

	test("returns already satisfied when no items match", async () => {
		const oreCargo = [{ item_id: "ore", name: "Iron Ore", quantity: 10, size: 1 }];
		const state = makeState({ cargo: oreCargo });
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: oreCargo }),
		});
		const ctx: GoalContext = { endpoints, state };

		// Sell list only wants gems, but cargo has ore
		const goal = new ListCargoForSale({ items: [{ itemId: "gems", minPrice: 100 }] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});
});
