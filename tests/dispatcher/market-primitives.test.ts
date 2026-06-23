import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../src/dispatcher/goals.js";
import {
	CreateMarketBuyOrder,
	CreateMarketSellOrder,
} from "../../src/dispatcher/primitives/index.js";
import type { StoredGameState } from "../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../fixtures/mock-endpoints.js";

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
		cargo: [{ item_id: "ore", item_name: "Ore", quantity: 10, size: 1 }],
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

describe("CreateMarketBuyOrder", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new CreateMarketBuyOrder("ore", 5, 100);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("must be docked");
	});

	test("creates buy order when docked", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			createBuyOrder: async () =>
				mockApiResponse({
					action: "create_buy_order",
					item: "Ore",
					item_id: "ore",
					quantity: 5,
					price_each: 100,
					quantity_filled: 3,
					quantity_listed: 2,
					total_escrowed: 200,
					total_spent: 300,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new CreateMarketBuyOrder("ore", 5, 100);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("3 filled");
		expect(result.message).toContain("2 listed");
	});

	test("reports all listed when no fills", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			createBuyOrder: async () =>
				mockApiResponse({
					action: "create_buy_order",
					item: "Ore",
					item_id: "ore",
					quantity: 10,
					price_each: 50,
					quantity_filled: 0,
					quantity_listed: 10,
					total_escrowed: 500,
					total_spent: 0,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new CreateMarketBuyOrder("ore", 10, 50);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.message).toContain("0 filled");
		expect(result.message).toContain("10 listed");
	});

	test("handles bulk-mode response shape", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			createBuyOrder: async () =>
				mockApiResponse({
					action: "create_buy_order",
					mode: "bulk",
					results: [{ item_id: "ore", quantity_filled: 5 }],
					summary: { total: 1, succeeded: 1, failed: 0 },
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new CreateMarketBuyOrder("ore", 5, 100);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("1/1 orders");
	});

	test("fails when bulk-mode response reports failures", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			createBuyOrder: async () =>
				mockApiResponse({
					action: "create_buy_order",
					mode: "bulk",
					results: [{ item_id: "ore", error: "insufficient_credits" }],
					summary: { total: 1, succeeded: 0, failed: 1 },
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new CreateMarketBuyOrder("ore", 5, 100);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("1/1 orders rejected");
	});
});

describe("CreateMarketSellOrder", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new CreateMarketSellOrder("ore", 5, 200);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("must be docked");
	});

	test("creates sell order when docked", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			createSellOrder: async () =>
				mockApiResponse({
					action: "create_sell_order",
					item_id: "ore",
					item_name: "Ore",
					quantity: 10,
					price_each: 200,
					quantity_filled: 5,
					quantity_listed: 5,
					total_earned: 1000,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new CreateMarketSellOrder("ore", 10, 200);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("5 filled");
		expect(result.message).toContain("+1000 credits");
		expect(result.message).toContain("5 listed");
	});

	test("reports zero earned when all listed", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			createSellOrder: async () =>
				mockApiResponse({
					action: "create_sell_order",
					item_id: "ore",
					item_name: "Ore",
					quantity: 5,
					price_each: 500,
					quantity_filled: 0,
					quantity_listed: 5,
					total_earned: 0,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new CreateMarketSellOrder("ore", 5, 500);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.message).toContain("0 filled");
		expect(result.message).toContain("+0 credits");
	});

	test("handles bulk-mode response shape", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			createSellOrder: async () =>
				mockApiResponse({
					action: "create_sell_order",
					mode: "bulk",
					results: [{ item_id: "ore", quantity_filled: 5 }],
					summary: { total: 1, succeeded: 1, failed: 0 },
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new CreateMarketSellOrder("ore", 5, 200);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("1/1 orders");
	});

	test("fails when bulk-mode response reports failures", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			createSellOrder: async () =>
				mockApiResponse({
					action: "create_sell_order",
					mode: "bulk",
					results: [{ item_id: "ore", error: "insufficient_cargo" }],
					summary: { total: 1, succeeded: 0, failed: 1 },
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new CreateMarketSellOrder("ore", 5, 200);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("1/1 orders rejected");
	});
});
