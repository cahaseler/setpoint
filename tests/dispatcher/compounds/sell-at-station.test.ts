import { describe, expect, test } from "bun:test";
import { SellAtStation } from "../../../src/dispatcher/compounds/sell-at-station.js";
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
	cargo_used: 20,
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
			cargo_used: 20,
		},
		cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 20, size: 1 }],
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

describe("SellAtStation", () => {
	test("already at station — sells cargo via market", async () => {
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () =>
				mockApiResponse({
					cargo: currentState.cargo,
				}),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						{
							item_id: "ore",
							item_name: "Iron Ore",
							best_buy: 10,
							best_sell: 0,
							buy_price: 10,
							buy_quantity: 500,
							sell_price: 0,
							sell_quantity: 0,
							buy_orders: [{ price_each: 10, quantity: 500 }],
							sell_orders: [],
						},
					],
				}),
			createSellOrdersBulk: async (orders) => {
				currentState = makeState({
					...currentState,
					cargo: [],
					ship: { ...defaultShip, ...currentState.ship, cargo_used: 0 },
				});
				return mockApiResponse({
					action: "create_sell_order",
					mode: "bulk",
					results: (orders as Array<unknown>).map((_o, i) => ({
						index: i,
						success: true,
						order_id: `order-${i}`,
					})),
					summary: {
						succeeded: (orders as Array<unknown>).length,
						failed: 0,
						total: (orders as Array<unknown>).length,
					},
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new SellAtStation({
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// PrepareAtStation steps (navigate, travel, dock = satisfied; refuel = 1 tick) + sell = 1 tick
		expect(result.steps.length).toBeGreaterThanOrEqual(2);
	});

	test("already at station with empty cargo — all satisfied", async () => {
		const state = makeState({ cargo: [] });
		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});

		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const goal = new SellAtStation({
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
			refuel: false,
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// PrepareAtStation (all satisfied) + SellOrDepositCargo (already satisfied)
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("depositTarget faction — deposits unsold cargo to faction storage", async () => {
		const factionDepositCalls: string[] = [];
		const state = makeState();
		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 20, size: 1 }],
				}),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [], // no buyers
				}),
			depositToFactionStorageBulk: async (items) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				for (const it of list) {
					factionDepositCalls.push(it.itemId);
				}
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const goal = new SellAtStation({
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
			refuel: false,
			depositTarget: "faction",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(factionDepositCalls).toEqual(["ore"]);
	});

	test("cashSource faction — withdraws credits from faction storage before refueling", async () => {
		let withdrawCalled = false;
		const state = makeState({
			player: { id: "p1", username: "Test", credits: 200 },
		});

		const endpoints = createMockEndpoints({
			viewFactionStorage: async () =>
				mockApiResponse({
					items: [],
					credits: 5000,
				}),
			withdrawFromFactionStorage: async (_itemId, _qty) => {
				withdrawCalled = true;
				return mockApiResponse({ action: "withdraw", message: "Withdrawn", quantity: 800 });
			},
			refuel: async () => mockApiResponse({}),
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 20, size: 1 }],
				}),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						{
							item_id: "ore",
							item_name: "Iron Ore",
							best_buy: 10,
							best_sell: 0,
							buy_price: 10,
							buy_quantity: 500,
							sell_price: 0,
							sell_quantity: 0,
							buy_orders: [{ price_each: 10, quantity: 500 }],
							sell_orders: [],
						},
					],
				}),
			createSellOrdersBulk: async (orders) =>
				mockApiResponse({
					action: "create_sell_order",
					mode: "bulk",
					results: (orders as Array<unknown>).map((_o, i) => ({
						index: i,
						success: true,
						order_id: `order-${i}`,
					})),
					summary: {
						succeeded: (orders as Array<unknown>).length,
						failed: 0,
						total: (orders as Array<unknown>).length,
					},
				}),
		});

		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const goal = new SellAtStation({
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
			cashSource: "faction",
			minCredits: 1000,
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(withdrawCalled).toBe(true);
	});

	test("skipMarket — deposits all cargo without checking market", async () => {
		const factionDepositCalls: string[] = [];
		let viewMarketCalled = false;
		const state = makeState();
		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 20, size: 1 }],
				}),
			viewMarket: async () => {
				viewMarketCalled = true;
				return mockApiResponse({ action: "view_market", base: "Sol Central", items: [] });
			},
			depositToFactionStorageBulk: async (items) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				for (const it of list) {
					factionDepositCalls.push(it.itemId);
				}
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const goal = new SellAtStation({
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
			refuel: false,
			depositTarget: "faction",
			skipMarket: true,
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(viewMarketCalled).toBe(false);
		expect(factionDepositCalls).toEqual(["ore"]);
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
			getCargo: async () =>
				mockApiResponse({
					cargo: currentState.cargo,
				}),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						{
							item_id: "ore",
							item_name: "Iron Ore",
							best_buy: 10,
							best_sell: 0,
							buy_price: 10,
							buy_quantity: 500,
							sell_price: 0,
							sell_quantity: 0,
							buy_orders: [{ price_each: 10, quantity: 500 }],
							sell_orders: [],
						},
					],
				}),
			createSellOrdersBulk: async (orders) =>
				mockApiResponse({
					action: "create_sell_order",
					mode: "bulk",
					results: (orders as Array<unknown>).map((_o, i) => ({
						index: i,
						success: true,
						order_id: `order-${i}`,
					})),
					summary: {
						succeeded: (orders as Array<unknown>).length,
						failed: 0,
						total: (orders as Array<unknown>).length,
					},
				}),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new SellAtStation({
			systemId: "sol",
			stationPoiId: "sol_station",
			baseId: "sol_base",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});
});
