import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../src/dispatcher/goals.js";
import { SellOrDepositCargo } from "../../src/dispatcher/primitives/sell-or-deposit-cargo.js";
import type { StoredGameState } from "../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../fixtures/mock-endpoints.js";

/** Default cargo used by most tests. */
const DEFAULT_CARGO = [
	{ item_id: "ore_iron", name: "Iron Ore", quantity: 20, size: 1 },
	{ item_id: "ore_copper", name: "Copper Ore", quantity: 10, size: 1 },
];

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
			cargo_used: 30,
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

/** Mock getCargo returning specific cargo items. */
function mockGetCargo(
	cargo: Array<{ item_id: string; name: string; quantity: number; size: number }>,
) {
	return async () => mockApiResponse({ cargo });
}

function marketItemWithBuyers(
	itemId: string,
	itemName: string,
	bestBuy: number,
	buyQuantity: number,
) {
	return {
		item_id: itemId,
		item_name: itemName,
		best_buy: bestBuy,
		best_sell: 0,
		buy_price: bestBuy,
		buy_quantity: buyQuantity,
		sell_price: 0,
		sell_quantity: 0,
		buy_orders: [{ price_each: bestBuy, quantity: buyQuantity }],
		sell_orders: [],
	};
}

function marketItemNoBuyers(itemId: string, itemName: string) {
	return {
		item_id: itemId,
		item_name: itemName,
		best_buy: 0,
		best_sell: 5,
		buy_price: 0,
		buy_quantity: 0,
		sell_price: 5,
		sell_quantity: 100,
		buy_orders: [],
		sell_orders: [{ price_each: 5, quantity: 100 }],
	};
}

/** Bulk create_sell_order response — every order succeeds with an order_id. */
function bulkSellResponse(orders: Array<{ itemId: string; quantity: number; price: number }>) {
	return mockApiResponse({
		action: "create_sell_order",
		mode: "bulk",
		results: orders.map((_o, i) => ({ index: i, success: true, order_id: `order-${i}` })),
		summary: { succeeded: orders.length, failed: 0, total: orders.length },
	});
}

/** Bulk deposit/withdraw response — every item succeeds. */
function bulkStorageResponse(items: Array<{ itemId: string; quantity: number }>) {
	return mockApiResponse({
		action: "deposit",
		requested: items.length,
		succeeded: items.length,
		failed: 0,
		results: items.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
	});
}

describe("SellOrDepositCargo", () => {
	test("already satisfied when cargo is empty", async () => {
		const state = makeState({ cargo: [] });
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo([]),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("already satisfied when cargo is undefined", async () => {
		const state = makeState({ cargo: undefined });
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("docked");
		expect(result.ticksUsed).toBe(0);
	});

	test("lists items with buy orders in one bulk sell call", async () => {
		let sellBulk: Array<{ itemId: string; quantity: number; price: number }> | undefined;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						marketItemWithBuyers("ore_iron", "Iron Ore", 3, 500),
						marketItemWithBuyers("ore_copper", "Copper Ore", 5, 200),
					],
				}),
			createSellOrdersBulk: async (orders) => {
				sellBulk = orders as Array<{ itemId: string; quantity: number; price: number }>;
				return bulkSellResponse(sellBulk);
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(sellBulk).toEqual([
			{ itemId: "ore_iron", quantity: 20, price: 3 },
			{ itemId: "ore_copper", quantity: 10, price: 5 },
		]);
		expect(result.message).toContain("2 listed on market");
	});

	test("deposits items without buy orders in one bulk deposit call", async () => {
		let depositBulk: Array<{ itemId: string; quantity: number }> | undefined;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						marketItemNoBuyers("ore_iron", "Iron Ore"),
						marketItemNoBuyers("ore_copper", "Copper Ore"),
					],
				}),
			depositToStorageBulk: async (items) => {
				depositBulk = items as Array<{ itemId: string; quantity: number }>;
				return bulkStorageResponse(depositBulk);
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(depositBulk).toEqual([
			{ itemId: "ore_iron", quantity: 20 },
			{ itemId: "ore_copper", quantity: 10 },
		]);
		expect(result.message).toContain("2 deposited to storage");
	});

	test("handles mixed cargo — one bulk sell, one bulk deposit", async () => {
		let sellBulk: Array<{ itemId: string; quantity: number; price: number }> | undefined;
		let depositBulk: Array<{ itemId: string; quantity: number }> | undefined;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						// Iron has buyers, copper does not
						marketItemWithBuyers("ore_iron", "Iron Ore", 3, 500),
						marketItemNoBuyers("ore_copper", "Copper Ore"),
					],
				}),
			createSellOrdersBulk: async (orders) => {
				sellBulk = orders as Array<{ itemId: string; quantity: number; price: number }>;
				return bulkSellResponse(sellBulk);
			},
			depositToStorageBulk: async (items) => {
				depositBulk = items as Array<{ itemId: string; quantity: number }>;
				return bulkStorageResponse(depositBulk);
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2);
		expect(sellBulk?.map((o) => o.itemId)).toEqual(["ore_iron"]);
		expect(depositBulk?.map((d) => d.itemId)).toEqual(["ore_copper"]);
		expect(result.message).toContain("1 listed on market");
		expect(result.message).toContain("1 deposited to storage");
	});

	test("deposits all when market has no matching items", async () => {
		let depositBulk: Array<{ itemId: string; quantity: number }> | undefined;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [], // empty market
				}),
			depositToStorageBulk: async (items) => {
				depositBulk = items as Array<{ itemId: string; quantity: number }>;
				return bulkStorageResponse(depositBulk);
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(depositBulk?.map((d) => d.itemId)).toEqual(["ore_iron", "ore_copper"]);
	});

	test("depositTarget faction — bulk-deposits unsold items to faction storage", async () => {
		let factionBulk: Array<{ itemId: string; quantity: number }> | undefined;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						marketItemNoBuyers("ore_iron", "Iron Ore"),
						marketItemNoBuyers("ore_copper", "Copper Ore"),
					],
				}),
			depositToFactionStorageBulk: async (items) => {
				factionBulk = items as Array<{ itemId: string; quantity: number }>;
				return bulkStorageResponse(factionBulk);
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo({ depositTarget: "faction" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(factionBulk).toEqual([
			{ itemId: "ore_iron", quantity: 20 },
			{ itemId: "ore_copper", quantity: 10 },
		]);
		expect(result.message).toContain("2 deposited to faction storage");
	});

	test("depositTarget faction — mixed cargo: bulk sell buyers, bulk faction-deposit rest", async () => {
		let sellBulk: Array<{ itemId: string; quantity: number; price: number }> | undefined;
		let factionBulk: Array<{ itemId: string; quantity: number }> | undefined;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						marketItemWithBuyers("ore_iron", "Iron Ore", 3, 500),
						marketItemNoBuyers("ore_copper", "Copper Ore"),
					],
				}),
			createSellOrdersBulk: async (orders) => {
				sellBulk = orders as Array<{ itemId: string; quantity: number; price: number }>;
				return bulkSellResponse(sellBulk);
			},
			depositToFactionStorageBulk: async (items) => {
				factionBulk = items as Array<{ itemId: string; quantity: number }>;
				return bulkStorageResponse(factionBulk);
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo({ depositTarget: "faction" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2);
		expect(sellBulk?.map((o) => o.itemId)).toEqual(["ore_iron"]);
		expect(factionBulk?.map((d) => d.itemId)).toEqual(["ore_copper"]);
		expect(result.message).toContain("1 listed on market");
		expect(result.message).toContain("1 deposited to faction storage");
	});

	test("depositTarget personal (explicit) — still uses personal storage", async () => {
		let depositBulk: Array<{ itemId: string; quantity: number }> | undefined;
		const singleCargo = [{ item_id: "ore_iron", name: "Iron Ore", quantity: 20, size: 1 }];
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(singleCargo),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [marketItemNoBuyers("ore_iron", "Iron Ore")],
				}),
			depositToStorageBulk: async (items) => {
				depositBulk = items as Array<{ itemId: string; quantity: number }>;
				return bulkStorageResponse(depositBulk);
			},
		});
		const singleItemState = makeState({
			cargo: singleCargo,
		});
		const ctx: GoalContext = { endpoints, state: singleItemState };

		const goal = new SellOrDepositCargo({ depositTarget: "personal" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(depositBulk?.map((d) => d.itemId)).toEqual(["ore_iron"]);
		expect(result.message).toContain("deposited to storage");
		expect(result.message).not.toContain("faction");
	});

	test("skips items with zero quantity", async () => {
		let sellBulk: Array<{ itemId: string; quantity: number; price: number }> | undefined;
		const mixedCargo = [
			{ item_id: "ore_iron", name: "Iron Ore", quantity: 10, size: 1 },
			{ item_id: "empty", name: "Empty", quantity: 0, size: 1 },
		];
		const state = makeState({ cargo: mixedCargo });
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(mixedCargo),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						marketItemWithBuyers("ore_iron", "Iron Ore", 3, 500),
						marketItemWithBuyers("empty", "Empty", 1, 10),
					],
				}),
			createSellOrdersBulk: async (orders) => {
				sellBulk = orders as Array<{ itemId: string; quantity: number; price: number }>;
				return bulkSellResponse(sellBulk);
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(sellBulk?.map((o) => o.itemId)).toEqual(["ore_iron"]);
	});

	test("listPrice — bulk-lists all cargo at specified price without querying market", async () => {
		let sellBulk: Array<{ itemId: string; quantity: number; price: number }> | undefined;
		let viewMarketCalled = false;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			viewMarket: async () => {
				viewMarketCalled = true;
				return mockApiResponse({ items: [] });
			},
			createSellOrdersBulk: async (orders) => {
				sellBulk = orders as Array<{ itemId: string; quantity: number; price: number }>;
				return bulkSellResponse(sellBulk);
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo({ listPrice: 150 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(viewMarketCalled).toBe(false); // no market query needed
		expect(sellBulk).toEqual([
			{ itemId: "ore_iron", quantity: 20, price: 150 },
			{ itemId: "ore_copper", quantity: 10, price: 150 },
		]);
		expect(result.message).toContain("2 listed on market");
	});

	test("listPrices — per-item prices override in a single bulk call", async () => {
		let sellBulk: Array<{ itemId: string; quantity: number; price: number }> | undefined;
		let viewMarketCalled = false;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			viewMarket: async () => {
				viewMarketCalled = true;
				return mockApiResponse({ items: [] });
			},
			createSellOrdersBulk: async (orders) => {
				sellBulk = orders as Array<{ itemId: string; quantity: number; price: number }>;
				return bulkSellResponse(sellBulk);
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo({ listPrices: { ore_iron: 50, ore_copper: 30 } });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(viewMarketCalled).toBe(false);
		expect(sellBulk).toEqual([
			{ itemId: "ore_iron", quantity: 20, price: 50 },
			{ itemId: "ore_copper", quantity: 10, price: 30 },
		]);
	});

	test("listPrices — items without a price fall through to bulk deposit", async () => {
		let sellBulk: Array<{ itemId: string; quantity: number; price: number }> | undefined;
		let depositBulk: Array<{ itemId: string; quantity: number }> | undefined;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			createSellOrdersBulk: async (orders) => {
				sellBulk = orders as Array<{ itemId: string; quantity: number; price: number }>;
				return bulkSellResponse(sellBulk);
			},
			depositToStorageBulk: async (items) => {
				depositBulk = items as Array<{ itemId: string; quantity: number }>;
				return bulkStorageResponse(depositBulk);
			},
		});
		const ctx: GoalContext = { endpoints, state };

		// Only iron has a configured price; copper has none and no market lookup
		// happens (listPrices set), so copper is deposited.
		const goal = new SellOrDepositCargo({ listPrices: { ore_iron: 50 } });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2);
		expect(sellBulk).toEqual([{ itemId: "ore_iron", quantity: 20, price: 50 }]);
		expect(depositBulk?.map((d) => d.itemId)).toEqual(["ore_copper"]);
	});

	test("counts only real successes from a bulk deposit with partial failure", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						marketItemNoBuyers("ore_iron", "Iron Ore"),
						marketItemNoBuyers("ore_copper", "Copper Ore"),
					],
				}),
			depositToStorageBulk: async () =>
				mockApiResponse({
					action: "deposit",
					requested: 2,
					succeeded: 1,
					failed: 1,
					results: [
						{ item_id: "ore_iron", quantity: 20, success: true },
						{ item_id: "ore_copper", quantity: 10, success: false, error: "storage full" },
					],
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("1 deposited to storage");
	});

	test("batches deposits over 50 item types into multiple ticks", async () => {
		const bigCargo = Array.from({ length: 60 }, (_v, i) => ({
			item_id: `ore_${i}`,
			name: `Ore ${i}`,
			quantity: 1,
			size: 1,
		}));
		const batchSizes: number[] = [];
		const state = makeState({ cargo: bigCargo });
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(bigCargo),
			depositToStorageBulk: async (items) => {
				const batch = items as Array<{ itemId: string; quantity: number }>;
				batchSizes.push(batch.length);
				return bulkStorageResponse(batch);
			},
		});

		const goal = new SellOrDepositCargo({ skipMarket: true });
		const result = await goal.execute(ctx(endpoints, state));

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2);
		expect(batchSizes).toEqual([50, 10]);
	});

	test("stops before the next bulk batch when the abort signal fires", async () => {
		const controller = new AbortController();
		let sellCalled = false;
		let depositCalled = false;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						// iron sells (bulk sell), copper deposits (bulk deposit)
						marketItemWithBuyers("ore_iron", "Iron Ore", 3, 500),
						marketItemNoBuyers("ore_copper", "Copper Ore"),
					],
				}),
			createSellOrdersBulk: async (orders) => {
				sellCalled = true;
				// Abort fires during the sell batch — the deposit batch must be skipped.
				controller.abort();
				return bulkSellResponse(
					orders as Array<{ itemId: string; quantity: number; price: number }>,
				);
			},
			depositToStorageBulk: async (items) => {
				depositCalled = true;
				return bulkStorageResponse(items as Array<{ itemId: string; quantity: number }>);
			},
		});
		const goalCtx: GoalContext = { endpoints, state, signal: controller.signal };

		const goal = new SellOrDepositCargo();
		const result = await goal.execute(goalCtx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(sellCalled).toBe(true);
		expect(depositCalled).toBe(false);
	});

	test("skipMarket bulk-deposits all items to faction storage without checking market", async () => {
		const state = makeState();
		let factionBulk: Array<{ itemId: string; quantity: number }> | undefined;

		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: DEFAULT_CARGO }),
			depositToFactionStorageBulk: async (items) => {
				factionBulk = items as Array<{ itemId: string; quantity: number }>;
				return bulkStorageResponse(factionBulk);
			},
		});
		const goalCtx: GoalContext = { endpoints, state };

		const goal = new SellOrDepositCargo({ depositTarget: "faction", skipMarket: true });
		const result = await goal.execute(goalCtx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(factionBulk?.map((d) => d.itemId)).toEqual(["ore_iron", "ore_copper"]);
	});
});

/** Build a GoalContext from endpoints + state. */
function ctx(endpoints: GoalContext["endpoints"], state: StoredGameState): GoalContext {
	return { endpoints, state };
}
