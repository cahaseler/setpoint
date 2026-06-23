import { describe, expect, test } from "bun:test";
import { EnsureMarketbook } from "../../../src/dispatcher/compounds/ensure-marketbook.js";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

interface MockOrder {
	order_id: string;
	item_id: string;
	item_name: string;
	side: string;
	quantity: number;
	price_each: number;
	remaining?: number;
}

function makeBulkResponse(
	action: string,
	results: Array<{
		index: number;
		success: boolean;
		order_id?: string;
		error_code?: string;
		error?: string;
	}>,
) {
	return {
		action,
		mode: "bulk" as const,
		results,
		summary: {
			succeeded: results.filter((r) => r.success).length,
			failed: results.filter((r) => !r.success).length,
			total: results.length,
		},
	};
}

function makeState(docked = true): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 1000 },
		ship: { id: "s1", hull: 100, max_hull: 100, fuel: 50, max_fuel: 50 },
		cargo: [],
		location: docked
			? {
					system_id: "sol",
					system_name: "Sol",
					poi_id: "sol_station",
					poi_name: "Sol Central",
					docked_at: "base-1",
				}
			: { system_id: "sol", system_name: "Sol" },
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

describe("EnsureMarketbook", () => {
	test("fails when not docked", async () => {
		const state = makeState(false);
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("docked");
		expect(result.ticksUsed).toBe(0);
	});

	test("already satisfied when all orders match", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-1",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 100,
					price_each: 5,
				},
			],
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("creates missing buy order", async () => {
		const state = makeState();
		let buyOrderCreated = false;

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [],
			createBuyOrdersBulk: async () => {
				buyOrderCreated = true;
				return mockApiResponse(
					makeBulkResponse("create_buy_order", [
						{ index: 0, success: true, order_id: "new-ord-1" },
					]),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(buyOrderCreated).toBe(true);
	});

	test("creates missing sell order", async () => {
		const state = makeState();
		let sellOrderCreated = false;

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [],
			createSellOrdersBulk: async () => {
				sellOrderCreated = true;
				return mockApiResponse(
					makeBulkResponse("create_sell_order", [
						{ index: 0, success: true, order_id: "new-ord-2" },
					]),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "refined_polymer", side: "sell", quantity: 20, price: 95 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(sellOrderCreated).toBe(true);
	});

	test("modifies order when price drifts beyond tolerance instead of cancel+recreate", async () => {
		const state = makeState();
		const modifiedOrders: Array<{ orderId: string; price: number }> = [];
		let cancelCalled = false;
		let createCalled = false;

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-1",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 100,
					price_each: 3, // target is 5, no tolerance → needs modify
				},
			],
			modifyOrder: async (orderId: unknown, price: unknown) => {
				modifiedOrders.push({ orderId: orderId as string, price: price as number });
				return mockApiResponse({ action: "modify_order", order_id: orderId, message: "ok" });
			},
			cancelOrdersBulk: async () => {
				cancelCalled = true;
				return mockApiResponse({ action: "cancel_order", results: [] });
			},
			createBuyOrdersBulk: async () => {
				createCalled = true;
				return mockApiResponse({ action: "create_buy_order", results: [] });
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1); // 1 modify, no cancel or create
		expect(modifiedOrders).toEqual([{ orderId: "ord-1", price: 5 }]);
		expect(cancelCalled).toBe(false);
		expect(createCalled).toBe(false);
	});

	test("matches order within priceTolerance", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-1",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 100,
					price_each: 95, // target is 100, tolerance 0.05 → 95 is within 5%
				},
			],
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "ore_iron", side: "buy", quantity: 100, price: 100 }],
			priceTolerance: 0.05,
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("modifies order outside priceTolerance", async () => {
		const state = makeState();
		let modifyCalled = false;

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-1",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 100,
					price_each: 80, // target 100, tolerance 0.05 → 80 is 20% off
				},
			],
			modifyOrder: async () => {
				modifyCalled = true;
				return mockApiResponse({ action: "modify_order", order_id: "ord-1", message: "ok" });
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "ore_iron", side: "buy", quantity: 100, price: 100 }],
			priceTolerance: 0.05,
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(modifyCalled).toBe(true);
	});

	test("tops up quantity when order is partially filled", async () => {
		const state = makeState();
		const createdOrders: Array<{ itemId: string; quantity: number; price: number }> = [];

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-1",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 100,
					price_each: 5,
					remaining: 60, // 40 filled, need top-up of 40
				},
			],
			createBuyOrdersBulk: async (orders: unknown) => {
				for (const o of orders as Array<{
					itemId: string;
					quantity: number;
					price: number;
				}>) {
					createdOrders.push(o);
				}
				return mockApiResponse(
					makeBulkResponse("create_buy_order", [{ index: 0, success: true, order_id: "top-up-1" }]),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(1); // 1 create for top-up
		expect(createdOrders).toEqual([{ itemId: "ore_iron", quantity: 40, price: 5 }]);
		expect(result.message).toContain("1 kept");
		expect(result.message).toContain("1 created");
	});

	test("keeps fully filled order and creates full replacement", async () => {
		const state = makeState();
		const createdOrders: Array<{ itemId: string; quantity: number; price: number }> = [];

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-1",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 100,
					price_each: 5,
					remaining: 0, // fully filled
				},
			],
			createBuyOrdersBulk: async (orders: unknown) => {
				for (const o of orders as Array<{
					itemId: string;
					quantity: number;
					price: number;
				}>) {
					createdOrders.push(o);
				}
				return mockApiResponse(
					makeBulkResponse("create_buy_order", [{ index: 0, success: true, order_id: "new-1" }]),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(createdOrders).toEqual([{ itemId: "ore_iron", quantity: 100, price: 5 }]);
	});

	test("modifies price and tops up quantity in same cycle", async () => {
		const state = makeState();
		const modifiedOrders: Array<{ orderId: string; price: number }> = [];
		const createdOrders: Array<{ itemId: string; quantity: number; price: number }> = [];

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-1",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "sell",
					quantity: 100,
					price_each: 80, // target is 95, needs modify
					remaining: 70, // 30 sold, needs 30 top-up
				},
			],
			modifyOrder: async (orderId: unknown, price: unknown) => {
				modifiedOrders.push({ orderId: orderId as string, price: price as number });
				return mockApiResponse({ action: "modify_order", order_id: orderId, message: "ok" });
			},
			createSellOrdersBulk: async (orders: unknown) => {
				for (const o of orders as Array<{
					itemId: string;
					quantity: number;
					price: number;
				}>) {
					createdOrders.push(o);
				}
				return mockApiResponse(
					makeBulkResponse("create_sell_order", [
						{ index: 0, success: true, order_id: "top-up-1" },
					]),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "ore_iron", side: "sell", quantity: 100, price: 95 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2); // 1 modify + 1 create
		expect(modifiedOrders).toEqual([{ orderId: "ord-1", price: 95 }]);
		expect(createdOrders).toEqual([{ itemId: "ore_iron", quantity: 30, price: 95 }]);
	});

	test("no top-up when remaining >= target quantity", async () => {
		const state = makeState();

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-1",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 200, // originally 200
					price_each: 5,
					remaining: 150, // remaining > target 100 → no top-up
				},
			],
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("cancelUnmatched: true cancels orders not in target list", async () => {
		const state = makeState();
		const cancelledIds: string[] = [];
		let sellOrderCreated = false;

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-match",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 100,
					price_each: 5,
				},
				{
					order_id: "ord-extra",
					item_id: "ore_copper",
					item_name: "Copper Ore",
					side: "buy",
					quantity: 50,
					price_each: 10,
				},
			],
			cancelOrdersBulk: async (orderIds: unknown) => {
				for (const id of orderIds as string[]) cancelledIds.push(id);
				return mockApiResponse(
					makeBulkResponse(
						"cancel_order",
						(orderIds as string[]).map((_, i) => ({ index: i, success: true })),
					),
				);
			},
			createSellOrdersBulk: async () => {
				sellOrderCreated = true;
				return mockApiResponse(
					makeBulkResponse("create_sell_order", [
						{ index: 0, success: true, order_id: "new-sell" },
					]),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [
				{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 }, // matches ord-match
				{ itemId: "refined_polymer", side: "sell", quantity: 20, price: 95 }, // new
			],
			cancelUnmatched: true,
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2); // 1 cancel batch + 1 sell batch
		expect(cancelledIds).toContain("ord-extra");
		expect(cancelledIds).not.toContain("ord-match");
		expect(sellOrderCreated).toBe(true);
	});

	test("cancelUnmatched: false leaves unmatched orders alone", async () => {
		const state = makeState();
		let cancelCalled = false;
		let sellOrderCreated = false;

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-match",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 100,
					price_each: 5,
				},
				{
					order_id: "ord-extra",
					item_id: "ore_copper",
					item_name: "Copper Ore",
					side: "buy",
					quantity: 50,
					price_each: 10,
				},
			],
			cancelOrdersBulk: async () => {
				cancelCalled = true;
				return mockApiResponse(makeBulkResponse("cancel_order", [{ index: 0, success: true }]));
			},
			createSellOrdersBulk: async () => {
				sellOrderCreated = true;
				return mockApiResponse(
					makeBulkResponse("create_sell_order", [
						{ index: 0, success: true, order_id: "new-sell" },
					]),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [
				{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 }, // matches
				{ itemId: "refined_polymer", side: "sell", quantity: 20, price: 95 }, // new
			],
			// cancelUnmatched defaults to false
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1); // only 1 create
		expect(cancelCalled).toBe(false); // ord-extra left alone
		expect(sellOrderCreated).toBe(true);
	});

	test("mixed: keep some, modify some, create some", async () => {
		const state = makeState();
		const modifiedOrders: Array<{ orderId: string; price: number }> = [];
		const createdSides: string[] = [];

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-keep",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 100,
					price_each: 5, // matches target exactly
				},
				{
					order_id: "ord-drift",
					item_id: "refined_polymer",
					item_name: "Refined Polymer",
					side: "sell",
					quantity: 20,
					price_each: 80, // price drifted, target is 95
				},
			],
			modifyOrder: async (orderId: unknown, price: unknown) => {
				modifiedOrders.push({ orderId: orderId as string, price: price as number });
				return mockApiResponse({ action: "modify_order", order_id: orderId, message: "ok" });
			},
			createBuyOrdersBulk: async () => {
				createdSides.push("buy");
				return mockApiResponse(
					makeBulkResponse("create_buy_order", [{ index: 0, success: true, order_id: "new-buy" }]),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [
				{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 }, // keeps ord-keep
				{ itemId: "refined_polymer", side: "sell", quantity: 20, price: 95 }, // modifies ord-drift
				{ itemId: "fuel_cell", side: "buy", quantity: 30, price: 7 }, // no existing, creates new
			],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(2); // 1 modify + 1 create buy
		expect(modifiedOrders).toEqual([{ orderId: "ord-drift", price: 95 }]);
		expect(createdSides).toContain("buy");
		expect(result.message).toContain("2 kept");
		expect(result.message).toContain("1 modified");
		expect(result.message).toContain("1 created");
	});

	test("batches many creates into a single tick per side", async () => {
		const state = makeState();
		let buyCalls = 0;
		let sellCalls = 0;
		let cancelCalls = 0;

		// 10 stale orders to cancel (unmatched)
		const staleOrders: MockOrder[] = Array.from({ length: 10 }, (_, i) => ({
			order_id: `stale-${i}`,
			item_id: `item_${i}`,
			item_name: `Item ${i}`,
			side: "buy",
			quantity: 50,
			price_each: 1,
		}));

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => staleOrders,
			cancelOrdersBulk: async (orderIds: unknown) => {
				cancelCalls++;
				return mockApiResponse(
					makeBulkResponse(
						"cancel_order",
						(orderIds as string[]).map((_, i) => ({ index: i, success: true })),
					),
				);
			},
			createBuyOrdersBulk: async (orders: unknown) => {
				buyCalls++;
				const items = orders as Array<unknown>;
				return mockApiResponse(
					makeBulkResponse(
						"create_buy_order",
						items.map((_, i) => ({ index: i, success: true, order_id: `buy-${i}` })),
					),
				);
			},
			createSellOrdersBulk: async (orders: unknown) => {
				sellCalls++;
				const items = orders as Array<unknown>;
				return mockApiResponse(
					makeBulkResponse(
						"create_sell_order",
						items.map((_, i) => ({ index: i, success: true, order_id: `sell-${i}` })),
					),
				);
			},
		});

		const targetOrders = [
			// 10 new buy orders (different items than stale)
			...Array.from({ length: 10 }, (_, i) => ({
				itemId: `new_buy_item_${i}`,
				side: "buy" as const,
				quantity: 100,
				price: 5,
			})),
			// 10 new sell orders
			...Array.from({ length: 10 }, (_, i) => ({
				itemId: `sell_item_${i}`,
				side: "sell" as const,
				quantity: 20,
				price: 50,
			})),
		];

		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({ targetOrders, cancelUnmatched: true });

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// 10 cancels in 1 bulk call = 1 tick
		// 10 buy creates in 1 bulk call = 1 tick
		// 10 sell creates in 1 bulk call = 1 tick
		expect(result.ticksUsed).toBe(3);
		expect(cancelCalls).toBe(1);
		expect(buyCalls).toBe(1);
		expect(sellCalls).toBe(1);
	});

	test("keeps multiple orders for same item+side when price matches (no churn)", async () => {
		const state = makeState();
		let cancelCalled = false;

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-1",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 100,
					price_each: 5,
					remaining: 70,
				},
				{
					order_id: "ord-2",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 30,
					price_each: 5,
					remaining: 30, // top-up from previous cycle
				},
			],
			cancelOrdersBulk: async () => {
				cancelCalled = true;
				return mockApiResponse(makeBulkResponse("cancel_order", [{ index: 0, success: true }]));
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true); // both kept, total remaining 100 >= 100
		expect(result.ticksUsed).toBe(0);
		expect(cancelCalled).toBe(false); // no cancel — both orders have correct price
	});

	test("excess wrong-price order left unmatched when good-price already covers target", async () => {
		// ord-good (100 remaining, correct price) satisfies the target on its own.
		// ord-stale (wrong price, excess) should be left unmatched — not modified.
		const state = makeState();
		let modifyCalled = false;
		let cancelCalled = false;
		let createCalled = false;

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-good",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 100,
					price_each: 5,
				},
				{
					order_id: "ord-stale",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 50,
					price_each: 3, // excess wrong-price order, not needed
				},
			],
			modifyOrder: async () => {
				modifyCalled = true;
				return mockApiResponse({ action: "modify_order", order_id: "x", message: "ok" });
			},
			cancelOrdersBulk: async () => {
				cancelCalled = true;
				return mockApiResponse(makeBulkResponse("cancel_order", [{ index: 0, success: true }]));
			},
			createBuyOrdersBulk: async () => {
				createCalled = true;
				return mockApiResponse(
					makeBulkResponse("create_buy_order", [{ index: 0, success: true, order_id: "new-1" }]),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true); // ord-good alone satisfies the target
		expect(result.ticksUsed).toBe(0);
		expect(modifyCalled).toBe(false); // excess ord-stale not touched
		expect(cancelCalled).toBe(false); // cancelUnmatched defaults to false
		expect(createCalled).toBe(false);
	});

	test("uses bad-price orders when needed to reach target quantity", async () => {
		// 7 orders @ 10cr (remaining=1 each) + 1 order @ 9cr (remaining=1) together cover target=8.
		// All 8 should be matched; the 9cr order gets modified. None cancelled.
		const state = makeState();
		const modifiedIds: string[] = [];
		let cancelCalled = false;

		const goodOrders = Array.from({ length: 7 }, (_, i) => ({
			order_id: `good-${i}`,
			item_id: "argon_gas",
			item_name: "Argon Gas",
			side: "sell",
			quantity: 1,
			price_each: 10,
			remaining: 1,
		}));

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				...goodOrders,
				{
					order_id: "bad-price",
					item_id: "argon_gas",
					item_name: "Argon Gas",
					side: "sell",
					quantity: 1,
					price_each: 9,
					remaining: 1,
				},
			],
			modifyOrder: async (orderId: unknown) => {
				modifiedIds.push(orderId as string);
				return mockApiResponse({ action: "modify_order", order_id: orderId, message: "ok" });
			},
			cancelOrdersBulk: async () => {
				cancelCalled = true;
				return mockApiResponse(makeBulkResponse("cancel_order", [{ index: 0, success: true }]));
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "argon_gas", side: "sell", quantity: 8, price: 10 }],
			cancelUnmatched: true,
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1); // 1 modify for bad-price order
		expect(modifiedIds).toEqual(["bad-price"]);
		expect(cancelCalled).toBe(false); // all 8 matched, none left to cancel
	});

	test("excess duplicate orders are left unmatched and cancelled when cancelUnmatched: true", async () => {
		// 50 sell orders for argon_gas @ 10cr (remaining=1 each), target=8.
		// Only 8 should be matched; the remaining 42 should be cancelled.
		const state = makeState();
		const cancelledIds: string[] = [];

		const duplicateOrders = Array.from({ length: 50 }, (_, i) => ({
			order_id: `dup-${i}`,
			item_id: "argon_gas",
			item_name: "Argon Gas",
			side: "sell",
			quantity: 1,
			price_each: 10,
			remaining: 1,
		}));

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => duplicateOrders,
			cancelOrdersBulk: async (orderIds: unknown) => {
				for (const id of orderIds as string[]) cancelledIds.push(id);
				return mockApiResponse(
					makeBulkResponse(
						"cancel_order",
						(orderIds as string[]).map((_, i) => ({ index: i, success: true })),
					),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [{ itemId: "argon_gas", side: "sell", quantity: 8, price: 10 }],
			cancelUnmatched: true,
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(cancelledIds).toHaveLength(42); // 50 total − 8 matched = 42 cancelled
		expect(result.message).toContain("8 kept");
		expect(result.message).toContain("42 cancelled");
	});

	test("reports partial bulk failure: some orders succeed, some fail", async () => {
		const state = makeState();

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [],
			createSellOrdersBulk: async () => {
				return mockApiResponse(
					makeBulkResponse("create_sell_order", [
						{ index: 0, success: true, order_id: "sell-1" },
						{
							index: 1,
							success: false,
							error_code: "insufficient_items",
							error: "Not enough ore_copper",
						},
						{ index: 2, success: true, order_id: "sell-3" },
					]),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [
				{ itemId: "ore_iron", side: "sell", quantity: 50, price: 10 },
				{ itemId: "ore_copper", side: "sell", quantity: 30, price: 8 },
				{ itemId: "ore_gold", side: "sell", quantity: 20, price: 15 },
			],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true); // partial success is still success
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("2 created");
		expect(result.message).toContain("1 failed");
	});

	test("reports total bulk failure: all orders fail", async () => {
		const state = makeState();

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [],
			createSellOrdersBulk: async () => {
				return mockApiResponse(
					makeBulkResponse("create_sell_order", [
						{
							index: 0,
							success: false,
							error_code: "insufficient_items",
							error: "Not enough ore_iron",
						},
						{
							index: 1,
							success: false,
							error_code: "insufficient_items",
							error: "Not enough ore_copper",
						},
					]),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [
				{ itemId: "ore_iron", side: "sell", quantity: 50, price: 10 },
				{ itemId: "ore_copper", side: "sell", quantity: 30, price: 8 },
			],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("failed");
	});

	test("detects phantom success: success=true but no order_id means order was not created", async () => {
		const state = makeState();

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [],
			createSellOrdersBulk: async () => {
				// Game server reports success but items were returned to storage
				// (e.g., player can't afford listing fees)
				return mockApiResponse({
					action: "create_sell_order",
					mode: "bulk" as const,
					results: [
						{
							index: 0,
							success: true,
							// no order_id — order was never created
							from_cargo: 0,
							from_storage: 10,
							returned_to_storage: 10,
							listing_fee: 0,
							message:
								"Sell order fully matched! Sold 0x Flex Polymer for 0 credits. No listing fee.",
						},
						{
							index: 1,
							success: true,
							// no order_id — same issue
							from_cargo: 0,
							from_storage: 5,
							returned_to_storage: 5,
							listing_fee: 0,
							message:
								"Sell order fully matched! Sold 0x Purified Water for 0 credits. No listing fee.",
						},
					],
					summary: { succeeded: 2, failed: 0, total: 2 },
				});
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [
				{ itemId: "refined_polymer", side: "sell", quantity: 10, price: 100 },
				{ itemId: "refined_water", side: "sell", quantity: 5, price: 50 },
			],
		});

		const result = await goal.execute(ctx);

		// Should detect that both "successes" are actually failures
		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("2 failure");
		expect(result.message).not.toContain("created");
	});

	test("stops syncing when the abort signal fires between order modifications", async () => {
		const state = makeState();
		const controller = new AbortController();
		let modifyCalls = 0;
		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [
				{
					order_id: "ord-1",
					item_id: "ore_iron",
					item_name: "Iron Ore",
					side: "buy",
					quantity: 100,
					price_each: 3, // target 5 → needs modify
				},
				{
					order_id: "ord-2",
					item_id: "ore_copper",
					item_name: "Copper Ore",
					side: "buy",
					quantity: 50,
					price_each: 2, // target 4 → needs modify
				},
			],
			modifyOrder: async (orderId: unknown) => {
				modifyCalls++;
				// Force abort lands while the first order is being modified — another
				// order still needs modifying, so only the signal can stop the loop.
				controller.abort();
				return mockApiResponse({ action: "modify_order", order_id: orderId, message: "ok" });
			},
		});
		const ctx: GoalContext = { endpoints, state, signal: controller.signal };
		const goal = new EnsureMarketbook({
			targetOrders: [
				{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 },
				{ itemId: "ore_copper", side: "buy", quantity: 50, price: 4 },
			],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(modifyCalls).toBe(1);
	});

	test("accurate counts with mixed bulk results across buy and sell", async () => {
		const state = makeState();

		const endpoints = createMockEndpoints({
			viewAllOrders: async () => [],
			createBuyOrdersBulk: async () => {
				return mockApiResponse(
					makeBulkResponse("create_buy_order", [
						{ index: 0, success: true, order_id: "buy-1" },
						{ index: 1, success: true, order_id: "buy-2" },
					]),
				);
			},
			createSellOrdersBulk: async () => {
				return mockApiResponse(
					makeBulkResponse("create_sell_order", [
						{ index: 0, success: true, order_id: "sell-1" },
						{ index: 1, success: false, error_code: "insufficient_items", error: "Not enough" },
					]),
				);
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const goal = new EnsureMarketbook({
			targetOrders: [
				{ itemId: "ore_iron", side: "buy", quantity: 100, price: 5 },
				{ itemId: "ore_copper", side: "buy", quantity: 50, price: 3 },
				{ itemId: "refined_polymer", side: "sell", quantity: 20, price: 95 },
				{ itemId: "ore_gold", side: "sell", quantity: 10, price: 50 },
			],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true); // 3 succeeded overall
		expect(result.ticksUsed).toBe(2); // 1 buy batch + 1 sell batch
		expect(result.message).toContain("3 created");
		expect(result.message).toContain("1 failed");
	});
});
