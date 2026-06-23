import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { runEnhancedMiningLoop } from "../../../src/dispatcher/loops/enhanced-mining-loop.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { ApiError } from "../../../src/util/errors.js";
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
			poi_id: "belt_1",
			poi_name: "Asteroid Belt",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function shipWithCargo(state: StoredGameState, cargoUsed: number) {
	const ship = state.ship;
	return {
		id: ship?.id ?? "s1",
		hull: ship?.hull ?? 100,
		max_hull: ship?.max_hull ?? 100,
		fuel: ship?.fuel ?? 50,
		max_fuel: ship?.max_fuel ?? 50,
		cargo_capacity: ship?.cargo_capacity ?? 100,
		cargo_used: cargoUsed,
	};
}

function buildEnhancedCycleMocks(
	extraMocks: Record<string, unknown> = {},
	initialState: Partial<StoredGameState> = {},
) {
	let currentState = makeState(initialState);
	let mineRound = 0;

	const endpoints = createMockEndpoints({
		getPoi: async () =>
			mockApiResponse({ poi: { id: "belt_1", type: "asteroid_belt", name: "Asteroid Belt" } }),
		findRoute: async () =>
			mockApiResponse({
				found: true,
				route: [{ system_id: "sol" }],
				total_jumps: 0,
				message: "Already in system",
			}),
		jump: async () => mockApiResponse({}),
		travel: async (poiId) => {
			const id = poiId as string;
			if (id === "sol_station") {
				currentState = makeState({
					...currentState,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "sol_station",
						poi_name: "Sol Central",
					},
				});
			} else {
				currentState = makeState({
					...currentState,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "belt_1",
						poi_name: "Asteroid Belt",
					},
					ship: shipWithCargo(currentState, 0),
					cargo: [],
				});
				mineRound = 0;
			}
			return mockApiResponse({});
		},
		dock: async () => {
			currentState = makeState({
				...currentState,
				location: { ...currentState.location, docked_at: "sol_base" },
			});
			return mockApiResponse({});
		},
		undock: async () => {
			const loc = currentState.location;
			currentState = makeState({
				...currentState,
				location: {
					system_id: loc?.system_id ?? "sol",
					system_name: loc?.system_name ?? "Sol",
					...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
					...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
				},
			});
			return mockApiResponse({});
		},
		mine: async () => {
			mineRound++;
			// First mine fills with junk, second mine fills clean
			if (mineRound === 1) {
				currentState = makeState({
					...currentState,
					ship: shipWithCargo(currentState, 100),
					cargo: [
						{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 70, size: 1 },
						{ item_id: "stone", item_name: "Stone", quantity: 30, size: 1 },
					],
				});
			} else {
				currentState = makeState({
					...currentState,
					ship: shipWithCargo(currentState, 100),
					cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 100, size: 1 }],
				});
			}
			return mockApiResponse({});
		},
		jettison: async () => {
			currentState = makeState({
				...currentState,
				ship: shipWithCargo(currentState, 70),
				cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 70, size: 1 }],
			});
			return mockApiResponse({
				item_id: "stone",
				item_name: "Stone",
				quantity: 30,
			});
		},
		getCargo: async () => mockApiResponse({ cargo: currentState.cargo, ship: currentState.ship }),
		viewMarket: async () =>
			mockApiResponse({
				action: "view_market",
				base: "Sol Central",
				items: [
					{
						item_id: "iron_ore",
						item_name: "Iron Ore",
						best_buy: 5,
						best_sell: 0,
						buy_price: 5,
						buy_quantity: 1000,
						sell_price: 0,
						sell_quantity: 0,
						buy_orders: [{ price_each: 5, quantity: 1000 }],
						sell_orders: [],
					},
				],
			}),
		createSellOrdersBulk: async (orders) => {
			const list = orders as Array<{ itemId: string; quantity: number; price: number }>;
			currentState = makeState({
				...currentState,
				ship: shipWithCargo(currentState, 0),
				cargo: [],
			});
			return mockApiResponse({
				action: "create_sell_order",
				mode: "bulk",
				results: list.map((_o, i) => ({ index: i, success: true, order_id: `order-${i}` })),
				summary: { succeeded: list.length, failed: 0, total: list.length },
			});
		},
		depositToStorageBulk: async (items) => {
			const list = items as Array<{ itemId: string; quantity: number }>;
			currentState = makeState({
				...currentState,
				ship: shipWithCargo(currentState, 0),
				cargo: [],
			});
			return mockApiResponse({
				action: "deposit",
				requested: list.length,
				succeeded: list.length,
				failed: 0,
				results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
			});
		},
		refuel: async () => mockApiResponse({}),
		repair: async () => mockApiResponse({}),
		...extraMocks,
	});

	return {
		endpoints,
		getState: () => currentState,
	};
}

describe("runEnhancedMiningLoop", () => {
	test("runs a full mine-with-jettison → sell iteration", async () => {
		const mocks = buildEnhancedCycleMocks();

		const ctx: GoalContext = {
			endpoints: mocks.endpoints,
			state: mocks.getState(),
			refreshState: async () => mocks.getState(),
		};

		const result = await runEnhancedMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				junkItemIds: ["stone"],
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("cancels via AbortSignal", async () => {
		const mocks = buildEnhancedCycleMocks();
		const controller = new AbortController();

		let refreshCount = 0;
		const ctx: GoalContext = {
			endpoints: mocks.endpoints,
			state: mocks.getState(),
			refreshState: async () => {
				refreshCount++;
				if (refreshCount >= 3) {
					controller.abort();
				}
				return mocks.getState();
			},
		};

		const result = await runEnhancedMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				junkItemIds: ["stone"],
				loopOptions: { signal: controller.signal, maxIterations: 10 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBeLessThan(10);
	});

	test("repair: true — repairs hull at sell station each iteration", async () => {
		let repairCalled = false;
		const damagedShip = {
			id: "s1",
			hull: 50,
			max_hull: 100,
			fuel: 50,
			max_fuel: 50,
			cargo_capacity: 100,
			cargo_used: 0,
		};
		const mocks = buildEnhancedCycleMocks(
			{
				repair: async () => {
					repairCalled = true;
					return mockApiResponse({});
				},
			},
			{ ship: damagedShip },
		);

		const ctx: GoalContext = {
			endpoints: mocks.endpoints,
			state: mocks.getState(),
			refreshState: async () => mocks.getState(),
		};

		const result = await runEnhancedMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				junkItemIds: ["stone"],
				repair: true,
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(repairCalled).toBe(true);
	});

	test("respects maxIterations", async () => {
		const mocks = buildEnhancedCycleMocks();

		const ctx: GoalContext = {
			endpoints: mocks.endpoints,
			state: mocks.getState(),
			refreshState: async () => mocks.getState(),
		};

		const result = await runEnhancedMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				junkItemIds: ["stone"],
				loopOptions: { maxIterations: 2 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
	});

	test("sells remaining cargo and stops cleanly on depletion without retryOnDepleted", async () => {
		let mineAttempts = 0;
		let sellOrderCreated = false;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			getPoi: async () =>
				mockApiResponse({ poi: { id: "belt_1", type: "asteroid_belt", name: "Asteroid Belt" } }),
			findRoute: async () =>
				mockApiResponse({
					found: true,
					route: [{ system_id: "sol" }],
					total_jumps: 0,
					message: "Already in system",
				}),
			travel: async (poiId) => {
				const id = poiId as string;
				if (id === "sol_station") {
					currentState = makeState({
						...currentState,
						location: {
							system_id: "sol",
							system_name: "Sol",
							poi_id: "sol_station",
							poi_name: "Sol Central",
						},
					});
				} else {
					currentState = makeState({
						...currentState,
						location: {
							system_id: "sol",
							system_name: "Sol",
							poi_id: "belt_1",
							poi_name: "Asteroid Belt",
						},
					});
				}
				return mockApiResponse({});
			},
			dock: async () => {
				currentState = makeState({
					...currentState,
					location: { ...currentState.location, docked_at: "sol_base" },
				});
				return mockApiResponse({});
			},
			undock: async () => {
				const loc = currentState.location;
				currentState = makeState({
					...currentState,
					location: {
						system_id: loc?.system_id ?? "sol",
						system_name: loc?.system_name ?? "Sol",
						...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
						...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
					},
				});
				return mockApiResponse({});
			},
			mine: async () => {
				mineAttempts++;
				if (mineAttempts <= 1) {
					currentState = makeState({
						...currentState,
						ship: shipWithCargo(currentState, 50),
						cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 50, size: 1 }],
					});
					return mockApiResponse({});
				}
				throw new ApiError("resources_depleted", "Resources depleted", 409);
			},
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					base: "Sol Central",
					items: [
						{
							item_id: "iron_ore",
							item_name: "Iron Ore",
							best_buy: 5,
							best_sell: 0,
							buy_price: 5,
							buy_quantity: 1000,
							sell_price: 0,
							sell_quantity: 0,
							buy_orders: [{ price_each: 5, quantity: 1000 }],
							sell_orders: [],
						},
					],
				}),
			createSellOrdersBulk: async (orders) => {
				sellOrderCreated = true;
				const list = orders as Array<{ itemId: string; quantity: number; price: number }>;
				currentState = makeState({
					...currentState,
					ship: shipWithCargo(currentState, 0),
					cargo: [],
				});
				return mockApiResponse({
					action: "create_sell_order",
					mode: "bulk",
					results: list.map((_o, i) => ({ index: i, success: true, order_id: `order-${i}` })),
					summary: { succeeded: list.length, failed: 0, total: list.length },
				});
			},
			refuel: async () => mockApiResponse({}),
			repair: async () => mockApiResponse({}),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const result = await runEnhancedMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				junkItemIds: ["stone"],
				loopOptions: { maxIterations: 10, retryDelayMs: 0 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(sellOrderCreated).toBe(true);
		expect(mineAttempts).toBe(2);
	});

	test("fails without gas harvester when target is gas_cloud", async () => {
		const currentState = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol_station",
				poi_name: "Sol Central",
				docked_at: "sol_base",
			},
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 0,
			},
			modules: [],
		});

		const endpoints = createMockEndpoints({
			getPoi: async () =>
				mockApiResponse({ poi: { id: "cloud_1", type: "gas_cloud", name: "Gas Cloud" } }),
			findRoute: async () =>
				mockApiResponse({
					found: true,
					route: [{ system_id: "sol" }],
					total_jumps: 0,
					message: "Already in system",
				}),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const result = await runEnhancedMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "cloud_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				junkItemIds: ["stone"],
				loopOptions: { maxIterations: 5 },
			},
			ctx,
		);

		expect(result.success).toBe(false);
		expect(result.iterationCount).toBe(0);
		expect(result.message).toContain("gas harvester");
	});
});
