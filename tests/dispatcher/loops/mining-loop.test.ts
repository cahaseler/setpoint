import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { runMiningLoop } from "../../../src/dispatcher/loops/mining-loop.js";
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

/**
 * Build mock endpoints that simulate a full mining cycle:
 * mine fills cargo → travel to station → dock → sell → travel back to belt
 */
function buildCycleMocks(
	extraMocks: Record<string, unknown> = {},
	initialState: Partial<StoredGameState> = {},
) {
	let currentState = makeState(initialState);

	const endpoints = createMockEndpoints({
		getPoi: async () =>
			mockApiResponse({ poi: { id: "belt_1", type: "asteroid_belt", name: "Asteroid Belt" } }),
		findRoute: async () =>
			mockApiResponse({
				found: true,
				route: [{ system_id: "sol" }],
				total_jumps: 0,
				message: "Already in system",
				fuel_per_jump: 0,
				estimated_fuel: 0,
				fuel_available: 50,
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
			currentState = makeState({
				...currentState,
				ship: shipWithCargo(currentState, 100),
				cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 100, size: 1 }],
			});
			return mockApiResponse({});
		},
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
		refuel: async () => mockApiResponse({}),
		repair: async () => mockApiResponse({}),
		...extraMocks,
	});

	return {
		endpoints,
		getState: () => currentState,
	};
}

describe("runMiningLoop", () => {
	test("runs a full mine → sell iteration", async () => {
		const mocks = buildCycleMocks();

		const ctx: GoalContext = {
			endpoints: mocks.endpoints,
			state: mocks.getState(),
			refreshState: async () => mocks.getState(),
		};

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("cancels via AbortSignal", async () => {
		const mocks = buildCycleMocks();
		const controller = new AbortController();

		let iterationDone = 0;
		const originalGetState = mocks.getState;
		const ctx: GoalContext = {
			endpoints: mocks.endpoints,
			state: originalGetState(),
			refreshState: async () => {
				iterationDone++;
				if (iterationDone >= 1) {
					controller.abort();
				}
				return originalGetState();
			},
		};

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { signal: controller.signal, maxIterations: 10 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBeLessThan(10);
	});

	test("stops on mining failure", async () => {
		const currentState = makeState();

		const endpoints = createMockEndpoints({
			getPoi: async () =>
				mockApiResponse({ poi: { id: "belt_1", type: "asteroid_belt", name: "Asteroid Belt" } }),
			findRoute: async () =>
				mockApiResponse({
					found: true,
					route: [],
					total_jumps: 0,
					message: "Already here",
				}),
			undock: async () => mockApiResponse({}),
			mine: async () => {
				throw new Error("Asteroid belt depleted");
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxIterations: 3, maxConsecutiveFailures: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("Asteroid belt depleted");
	});

	test("depositTarget faction — deposits cargo to faction storage instead of selling", async () => {
		let currentState = makeState();
		const factionDepositCalls: string[] = [];

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
						ship: shipWithCargo(currentState, 0),
						cargo: [],
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
				currentState = makeState({
					...currentState,
					ship: shipWithCargo(currentState, 100),
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 100, size: 1 }],
				});
				return mockApiResponse({});
			},
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
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
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				depositTarget: "faction",
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(factionDepositCalls).toContain("ore");
	});

	test("cashSource faction — withdraws credits from faction storage before refueling", async () => {
		const mocks = buildCycleMocks();
		let withdrawCalled = false;

		// Extend the mocks with faction storage endpoints
		const stateWithLowCredits = makeState({
			player: { id: "p1", username: "Test", credits: 100 },
		});

		const endpoints = createMockEndpoints({
			...Object.fromEntries(
				(
					[
						"getPoi",
						"findRoute",
						"jump",
						"travel",
						"dock",
						"undock",
						"mine",
						"getCargo",
						"viewMarket",
						"createSellOrdersBulk",
						"repair",
					] as const
				).map((k) => [k, (mocks.endpoints as unknown as Record<string, unknown>)[k]]),
			),
			refuel: async () => mockApiResponse({}),
			viewFactionStorage: async () =>
				mockApiResponse({
					items: [],
					credits: 5000,
				}),
			withdrawFromFactionStorage: async (_itemId, _qty) => {
				withdrawCalled = true;
				return mockApiResponse({ action: "withdraw", message: "Withdrawn", quantity: 900 });
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: stateWithLowCredits,
			refreshState: async () => ({
				...mocks.getState(),
				player: { id: "p1", username: "Test", credits: 100 },
			}),
		};

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				cashSource: "faction",
				minCredits: 1000,
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(withdrawCalled).toBe(true);
	});

	test("skipMarket — deposits all cargo to faction storage without selling", async () => {
		let currentState = makeState();
		const factionDepositCalls: string[] = [];
		let viewMarketCalled = false;

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
						ship: shipWithCargo(currentState, 0),
						cargo: [],
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
				currentState = makeState({
					...currentState,
					ship: shipWithCargo(currentState, 100),
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 100, size: 1 }],
				});
				return mockApiResponse({});
			},
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			viewMarket: async () => {
				viewMarketCalled = true;
				return mockApiResponse({ action: "view_market", base: "Sol Central", items: [] });
			},
			depositToFactionStorageBulk: async (items) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				for (const it of list) {
					factionDepositCalls.push(it.itemId);
				}
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
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				depositTarget: "faction",
				skipMarket: true,
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(viewMarketCalled).toBe(false);
		expect(factionDepositCalls).toContain("ore");
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
		const mocks = buildCycleMocks(
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

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				repair: true,
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(repairCalled).toBe(true);
	});

	test("respects maxIterations", async () => {
		const mocks = buildCycleMocks();

		const ctx: GoalContext = {
			endpoints: mocks.endpoints,
			state: mocks.getState(),
			refreshState: async () => mocks.getState(),
		};

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxIterations: 2 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
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

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "cloud_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxIterations: 5 },
			},
			ctx,
		);

		expect(result.success).toBe(false);
		expect(result.iterationCount).toBe(0);
		expect(result.message).toContain("gas harvester");
	});

	test("fails without ice harvester when target is ice_field", async () => {
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
			modules: [{ type_id: "laser_miner_mk1", module_id: "m1" }],
		});

		const endpoints = createMockEndpoints({
			getPoi: async () =>
				mockApiResponse({ poi: { id: "ice_1", type: "ice_field", name: "Ice Field" } }),
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

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "ice_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxIterations: 5 },
			},
			ctx,
		);

		expect(result.success).toBe(false);
		expect(result.iterationCount).toBe(0);
		expect(result.message).toContain("ice harvester");
	});

	test("proceeds normally with gas harvester when target is gas_cloud", async () => {
		const modules = [{ type_id: "gas_harvester_mk1", module_id: "m1" }];
		const mocks = buildCycleMocks({
			getPoi: async () =>
				mockApiResponse({ poi: { id: "cloud_1", type: "gas_cloud", name: "Gas Cloud" } }),
		});

		const ctx: GoalContext = {
			endpoints: mocks.endpoints,
			state: { ...mocks.getState(), modules },
			refreshState: async () => ({ ...mocks.getState(), modules }),
		};

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "cloud_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
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
				// First mine succeeds (partial cargo), second mine hits depletion
				if (mineAttempts <= 1) {
					currentState = makeState({
						...currentState,
						ship: shipWithCargo(currentState, 50),
						cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 50, size: 1 }],
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
							item_id: "ore",
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

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				// retryOnDepleted NOT set — should sell and stop
				loopOptions: { maxIterations: 10, retryDelayMs: 0 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(sellOrderCreated).toBe(true);
		expect(mineAttempts).toBe(2);
	});

	test("returns to station on depletion even with empty cargo", async () => {
		let dockCalled = false;
		let refuelCalled = false;
		let currentState = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 10,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 0,
			},
		});

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
				dockCalled = true;
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
				// First mine attempt hits depletion immediately — empty cargo
				throw new ApiError("resources_depleted", "Resources depleted", 409);
			},
			getCargo: async () => mockApiResponse({ cargo: [] }),
			viewMarket: async () =>
				mockApiResponse({ action: "view_market", base: "Sol Central", items: [] }),
			refuel: async () => {
				refuelCalled = true;
				return mockApiResponse({});
			},
			repair: async () => mockApiResponse({}),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxIterations: 10, retryDelayMs: 0 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(dockCalled).toBe(true);
		expect(refuelCalled).toBe(true);
	});

	test("retryOnDepleted — retries resources depleted without counting as failure", async () => {
		let mineAttempts = 0;
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
						ship: shipWithCargo(currentState, 0),
						cargo: [],
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
			mine: async () => {
				mineAttempts++;
				if (mineAttempts === 1) {
					throw new ApiError("resources_depleted", "Resources depleted", 409);
				}
				currentState = makeState({
					...currentState,
					ship: shipWithCargo(currentState, 100),
					cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 100, size: 1 }],
				});
				return mockApiResponse({});
			},
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
			refuel: async () => mockApiResponse({}),
			repair: async () => mockApiResponse({}),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const result = await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				retryOnDepleted: true,
				// maxConsecutiveFailures: 1 would stop without retryOnDepleted
				loopOptions: { maxIterations: 1, maxConsecutiveFailures: 1, retryDelayMs: 0 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(mineAttempts).toBe(2); // first attempt depleted, second succeeded
	});

	test("round-trip fuel check — refuels at sell station before departing when fuel is low", async () => {
		// Ship has 40 fuel. Round trip needs 60 (30 out + 30 back, 1 hop each way).
		// Should dock and refuel at sell station before navigating to belt.
		let refuelCallCount = 0;
		let mineAttempts = 0;
		let currentState = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 40,
				max_fuel: 100,
				cargo_capacity: 100,
				cargo_used: 0,
			},
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol_station",
				poi_name: "Sol Central",
				docked_at: "sol_base",
			},
		});

		const endpoints = createMockEndpoints({
			getPoi: async () =>
				mockApiResponse({ poi: { id: "belt_1", type: "asteroid_belt", name: "Asteroid Belt" } }),
			findRoute: async () =>
				mockApiResponse({
					found: true,
					// Route from current position (sol) to alpha: [sol (start, skipped), alpha]
					route: [
						{ system_id: "sol", name: "Sol", jumps: 0 },
						{ system_id: "alpha", name: "Alpha", jumps: 1 },
					],
					total_jumps: 1,
					message: "Route found",
					fuel_per_jump: 30,
					estimated_fuel: 30,
					fuel_available: 100, // after pre-flight refuel the ship has 100
				}),
			jump: async () => {
				currentState = makeState({
					...currentState,
					location: {
						system_id: "alpha",
						system_name: "Alpha",
						poi_id: "belt_1",
						poi_name: "Belt",
					},
				});
				return mockApiResponse({});
			},
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
							system_id: "alpha",
							system_name: "Alpha",
							poi_id: "belt_1",
							poi_name: "Belt",
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
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, cargo_used: 100, fuel: 10 },
					cargo: [{ item_id: "ore", item_name: "Ore", quantity: 100, size: 1 }],
				});
				return mockApiResponse({});
			},
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			viewMarket: async () =>
				mockApiResponse({ action: "view_market", base: "Sol Central", items: [] }),
			refuel: async () => {
				refuelCallCount++;
				currentState = makeState({ ...currentState, ship: { ...currentState.ship, fuel: 100 } });
				return mockApiResponse({});
			},
			repair: async () => mockApiResponse({}),
			depositToStorageBulk: async (items) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, cargo_used: 0 },
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
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const result = await runMiningLoop(
			{
				miningSystemId: "alpha",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxIterations: 1, retryDelayMs: 0 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		// Refueled at least once before departing (fuel 40 < needed 60)
		expect(refuelCallCount).toBeGreaterThan(0);
		expect(mineAttempts).toBe(1);
	});

	test("round-trip fuel check — proceeds without refuel when fuel is sufficient", async () => {
		// Ship has 150 fuel, round trip needs 60. No pre-flight refuel should happen.
		let refuelBeforeMine = false;
		let mineAttempts = 0;
		let currentState = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 150,
				max_fuel: 200,
				cargo_capacity: 100,
				cargo_used: 0,
			},
		});

		const endpoints = createMockEndpoints({
			getPoi: async () =>
				mockApiResponse({ poi: { id: "belt_1", type: "asteroid_belt", name: "Asteroid Belt" } }),
			findRoute: async () =>
				mockApiResponse({
					found: true,
					route: [{ system_id: "sol" }],
					total_jumps: 0,
					message: "Same system",
					fuel_per_jump: 0,
					estimated_fuel: 0,
					fuel_available: 150,
				}),
			travel: async (poiId) => {
				const id = poiId as string;
				currentState = makeState({
					...currentState,
					location: { system_id: "sol", system_name: "Sol", poi_id: id, poi_name: id },
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
			undock: async () => {
				const loc = currentState.location;
				currentState = makeState({
					...currentState,
					location: {
						system_id: loc?.system_id ?? "sol",
						system_name: "Sol",
						...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
						...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
					},
				});
				return mockApiResponse({});
			},
			mine: async () => {
				mineAttempts++;
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, cargo_used: 100 },
					cargo: [{ item_id: "ore", item_name: "Ore", quantity: 100, size: 1 }],
				});
				return mockApiResponse({});
			},
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			viewMarket: async () =>
				mockApiResponse({ action: "view_market", base: "Sol Central", items: [] }),
			refuel: async () => {
				if (mineAttempts === 0) refuelBeforeMine = true;
				return mockApiResponse({});
			},
			repair: async () => mockApiResponse({}),
			depositToStorageBulk: async (items) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				currentState = makeState({
					...currentState,
					ship: { ...currentState.ship, cargo_used: 0 },
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
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		await runMiningLoop(
			{
				miningSystemId: "sol",
				beltPoiId: "belt_1",
				sellSystemId: "sol",
				sellStationPoiId: "sol_station",
				sellBaseId: "sol_base",
				loopOptions: { maxIterations: 1, retryDelayMs: 0 },
			},
			ctx,
		);

		// No pre-flight refuel was needed
		expect(refuelBeforeMine).toBe(false);
		expect(mineAttempts).toBe(1);
	});
});
