import { describe, expect, test } from "bun:test";
import { UnloadAtStation } from "../../../src/dispatcher/compounds/unload-at-station.js";
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

const cargoState = {
	ship: {
		id: "s1",
		hull: 100,
		max_hull: 100,
		fuel: 50,
		max_fuel: 50,
		cargo_capacity: 100,
		cargo_used: 30,
	},
	cargo: [{ item_id: "ore", name: "Iron Ore", quantity: 30, size: 1 }],
};

describe("UnloadAtStation", () => {
	test("unloads to personal storage", async () => {
		// personal-storage uses SellOrDepositCargo, which sells via market if buyers exist
		// or deposits to storage if no buyers.
		let currentState = makeState(cargoState);

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						{
							item_id: "ore",
							item_name: "Iron Ore",
							best_buy: 5,
							best_sell: 0,
							buy_price: 5,
							buy_quantity: 500,
							sell_price: 0,
							sell_quantity: 0,
							buy_orders: [{ price_each: 5, quantity: 500 }],
							sell_orders: [],
						},
					],
				}),
			createSellOrdersBulk: async (...args: unknown[]) => {
				const orders = args[0] as Array<{ itemId: string; quantity: number; price: number }>;
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, cargo_used: 0 },
					cargo: [],
				});
				return mockApiResponse({
					action: "create_sell_order",
					mode: "bulk",
					results: orders.map((_o, i) => ({ index: i, success: true, order_id: `order-${i}` })),
					summary: { succeeded: orders.length, failed: 0, total: orders.length },
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new UnloadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			destType: "personal-storage",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("unloads to faction storage", async () => {
		let currentState = makeState(cargoState);

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToFactionStorageBulk: async (...args: unknown[]) => {
				const items = args[0] as Array<{ itemId: string; quantity: number }>;
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, cargo_used: 0 },
					cargo: [],
				});
				return mockApiResponse({
					action: "deposit",
					requested: items.length,
					succeeded: items.length,
					failed: 0,
					results: items.map((it) => ({
						item_id: it.itemId,
						quantity: it.quantity,
						success: true,
					})),
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new UnloadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			destType: "faction-storage",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("faction-storage unload succeeds when live cargo is empty (stale state snapshot)", async () => {
		// State snapshot says steel_plate is in cargo (stale from previous cycle),
		// but live getCargo returns empty. Goal should succeed (alreadySatisfied),
		// not fail with "No steel_plate in cargo to deposit".
		const staleState = makeState({
			...cargoState,
			cargo: [{ item_id: "steel_plate", item_name: "Steel Plate", quantity: 5, size: 1 }],
		});

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			// Live cargo is empty — items were already deposited
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: staleState, // stale: shows steel_plate, but live is empty
			refreshState: async () => staleState,
		};

		const goal = new UnloadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			destType: "faction-storage",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
	});

	test("unloads as gift", async () => {
		let currentState = makeState(cargoState);

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			giftToPlayer: async () => {
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, cargo_used: 0 },
					cargo: [],
				});
				return mockApiResponse({
					action: "deposit",
					message: "Gifted to Friend",
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new UnloadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			destType: "gift",
			targetPlayer: "Friend",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("unloads to market with prices", async () => {
		let currentState = makeState(cargoState);

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

		const goal = new UnloadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			destType: "market",
			items: [{ itemId: "ore", minPrice: 10 }],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("fails cleanly on an unknown destType instead of crashing", async () => {
		// The registry validates destType, but the goal must also defend itself:
		// an unrecognized value previously made buildUnloadSteps return undefined,
		// crashing the job with a spread-syntax error.
		const goal = new UnloadAtStation({
			systemId: "sol",
			poiId: "sol_station",
			baseId: "sol_base",
			destType: "faction" as unknown as "faction-storage",
		});
		const ctx: GoalContext = { endpoints: createMockEndpoints(), state: makeState() };

		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain('Unknown destType "faction"');
	});
});
