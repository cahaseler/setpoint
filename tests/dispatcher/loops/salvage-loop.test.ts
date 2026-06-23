import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { runSalvageLoop } from "../../../src/dispatcher/loops/salvage-loop.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

const defaultShip = {
	id: "s1",
	hull: 100,
	max_hull: 100,
	fuel: 50,
	max_fuel: 50,
	cargo_capacity: 100,
	cargo_used: 0,
};

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 1000 },
		ship: { ...defaultShip },
		cargo: [],
		location: {
			system_id: "sol",
			system_name: "Sol",
			poi_id: "belt_1",
			poi_name: "Jettison Zone",
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

function makeWreck(id: string, cargoItems: number) {
	return {
		id,
		cargo:
			cargoItems > 0 ? [{ item_id: "iron_ore", quantity: 10 * cargoItems, name: "Iron Ore" }] : [],
		modules: [],
		salvage_value: 100,
		ship_class: "hauler",
		victim_id: "p2",
		victim_name: "Victim",
		created_at: "2026-01-01T00:00:00Z",
		expires_at: "2026-01-01T01:00:00Z",
		expire_tick: 999,
	};
}

const defaultOptions = {
	salvageSystemId: "sol",
	salvagePoiId: "belt_1",
	sellSystemId: "sol",
	sellStationPoiId: "sol_station",
	sellBaseId: "sol_base",
};

describe("runSalvageLoop", () => {
	test("runs one iteration: loot wrecks → sell at station", async () => {
		const currentState = { value: makeState() };
		let lootCalled = false;
		let sellCalled = false;

		const endpoints = createMockEndpoints({
			getState: async () => mockApiResponse({}),
			findRoute: async () =>
				mockApiResponse({
					found: true,
					route: [{ system_id: "sol", name: "Sol", jumps: 0 }],
					total_jumps: 0,
					message: "Same system",
					fuel_per_jump: 0,
					estimated_fuel: 0,
					fuel_available: 50,
				}),
			undock: async () => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "belt_1",
						poi_name: "Jettison Zone",
					},
				});
				return mockApiResponse({});
			},
			getWrecks: async () =>
				mockApiResponse({
					count: 1,
					wrecks: [makeWreck("w1", 3)],
				}),
			lootWreck: async () => {
				lootCalled = true;
				currentState.value = makeState({
					...currentState.value,
					ship: { ...defaultShip, cargo_used: 100 },
				});
				return mockApiResponse({ quantity: 100, wreck_empty: false });
			},
			travel: async (poiId) => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: poiId as string,
						poi_name: String(poiId),
					},
				});
				return mockApiResponse({});
			},
			dock: async (baseId) => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						...currentState.value.location,
						docked_at: baseId as string,
					},
				});
				return mockApiResponse({});
			},
			refuel: async () => {
				currentState.value = makeState({
					...currentState.value,
					ship: { ...defaultShip, cargo_used: 100, fuel: 50 },
				});
				return mockApiResponse({});
			},
			getCargo: async () => mockApiResponse({ cargo: [{ item_id: "iron_ore", quantity: 100 }] }),
			viewMarket: async () => mockApiResponse({ items: [{ item_id: "iron_ore", best_buy: 5 }] }),
			createSellOrdersBulk: async (orders: unknown) => {
				sellCalled = true;
				currentState.value = makeState({
					...currentState.value,
					ship: { ...defaultShip, cargo_used: 0 },
				});
				const orderList = orders as Array<{ itemId: string; quantity: number; price: number }>;
				return mockApiResponse({
					action: "create_sell_order",
					mode: "bulk",
					results: orderList.map((_o, i) => ({ index: i, success: true, order_id: `order-${i}` })),
					summary: { succeeded: orderList.length, failed: 0, total: orderList.length },
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runSalvageLoop(
			{ ...defaultOptions, loopOptions: { maxIterations: 1 } },
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(lootCalled).toBe(true);
		expect(sellCalled).toBe(true);
	});

	test("continues when no wrecks found (waits for new wrecks)", async () => {
		const currentState = { value: makeState() };
		let iterationCount = 0;

		const endpoints = createMockEndpoints({
			getState: async () => mockApiResponse({}),
			undock: async () => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "belt_1",
						poi_name: "Jettison Zone",
					},
				});
				return mockApiResponse({});
			},
			findRoute: async () =>
				mockApiResponse({
					found: true,
					route: [{ system_id: "sol", name: "Sol", jumps: 0 }],
					total_jumps: 0,
					message: "Same system",
					fuel_per_jump: 0,
					estimated_fuel: 0,
					fuel_available: 50,
				}),
			getWrecks: async () => {
				iterationCount++;
				return mockApiResponse({ count: 0, wrecks: [] });
			},
			travel: async (poiId) => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: poiId as string,
						poi_name: String(poiId),
					},
				});
				return mockApiResponse({});
			},
			dock: async (baseId) => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						...currentState.value.location,
						docked_at: baseId as string,
					},
				});
				return mockApiResponse({});
			},
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: [] }),
			viewMarket: async () => mockApiResponse({ items: [] }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runSalvageLoop(
			{ ...defaultOptions, loopOptions: { maxIterations: 3 } },
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(3);
		expect(iterationCount).toBe(3); // Checked for wrecks each iteration
	});

	test("repairs at sell station when repair: true", async () => {
		const currentState = { value: makeState({ ship: { ...defaultShip, hull: 50 } }) };
		let repairCalled = false;

		const endpoints = createMockEndpoints({
			getState: async () => mockApiResponse({}),
			undock: async () => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "belt_1",
						poi_name: "Jettison Zone",
					},
				});
				return mockApiResponse({});
			},
			findRoute: async () =>
				mockApiResponse({
					found: true,
					route: [{ system_id: "sol", name: "Sol", jumps: 0 }],
					total_jumps: 0,
					message: "Same system",
					fuel_per_jump: 0,
					estimated_fuel: 0,
					fuel_available: 50,
				}),
			getWrecks: async () => mockApiResponse({ count: 0, wrecks: [] }),
			travel: async (poiId) => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: poiId as string,
						poi_name: String(poiId),
					},
				});
				return mockApiResponse({});
			},
			dock: async (baseId) => {
				currentState.value = makeState({
					...currentState.value,
					location: { ...currentState.value.location, docked_at: baseId as string },
				});
				return mockApiResponse({});
			},
			refuel: async () => mockApiResponse({}),
			repair: async () => {
				repairCalled = true;
				currentState.value = makeState({
					...currentState.value,
					ship: { ...defaultShip, hull: 100 },
				});
				return mockApiResponse({});
			},
			getCargo: async () => mockApiResponse({ cargo: [] }),
			viewMarket: async () => mockApiResponse({ items: [] }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runSalvageLoop(
			{ ...defaultOptions, repair: true, loopOptions: { maxIterations: 1 } },
			ctx,
		);

		expect(result.success).toBe(true);
		expect(repairCalled).toBe(true);
	});

	test("cancels via AbortSignal", async () => {
		const controller = new AbortController();
		const currentState = { value: makeState() };
		let iterationCount = 0;

		const endpoints = createMockEndpoints({
			getState: async () => mockApiResponse({}),
			undock: async () => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "belt_1",
						poi_name: "Jettison Zone",
					},
				});
				return mockApiResponse({});
			},
			findRoute: async () =>
				mockApiResponse({
					found: true,
					route: [{ system_id: "sol", name: "Sol", jumps: 0 }],
					total_jumps: 0,
					message: "Same system",
					fuel_per_jump: 0,
					estimated_fuel: 0,
					fuel_available: 50,
				}),
			getWrecks: async () => {
				iterationCount++;
				if (iterationCount >= 2) {
					controller.abort();
				}
				return mockApiResponse({ count: 0, wrecks: [] });
			},
			travel: async (poiId) => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: poiId as string,
						poi_name: String(poiId),
					},
				});
				return mockApiResponse({});
			},
			dock: async (baseId) => {
				currentState.value = makeState({
					...currentState.value,
					location: { ...currentState.value.location, docked_at: baseId as string },
				});
				return mockApiResponse({});
			},
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: [] }),
			viewMarket: async () => mockApiResponse({ items: [] }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runSalvageLoop(
			{
				...defaultOptions,
				loopOptions: { signal: controller.signal, maxIterations: 10 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBeLessThan(10);
	});
});
