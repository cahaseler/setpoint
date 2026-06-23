import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { runHaulingLoop } from "../../../src/dispatcher/loops/hauling-loop.js";
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
			poi_id: "source_station",
			poi_name: "Source Station",
			docked_at: "source_base",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

/**
 * Build mock endpoints that simulate a full load → unload cycle using personal storage:
 * - Start docked at source station
 * - viewStorage() finds items, withdrawFromStorage() fills cargo
 * - travel to dest station + dock
 * - viewMarket() + createSellOrder() empties cargo (SellOrDepositCargo path)
 * - travel back to source for next iteration
 */
function buildCycleMocks() {
	let currentState = makeState();
	let atSourceStation = true;

	const endpoints = createMockEndpoints({
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
			if (id === "dest_station") {
				atSourceStation = false;
				currentState = makeState({
					...currentState,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "dest_station",
						poi_name: "Dest Station",
					},
				});
			} else {
				// Travelling back to source station
				atSourceStation = true;
				currentState = makeState({
					...currentState,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "source_station",
						poi_name: "Source Station",
					},
					ship: { ...currentState.ship, cargo_used: 0 },
					cargo: [],
				});
			}
			return mockApiResponse({});
		},
		dock: async () => {
			const baseId = atSourceStation ? "source_base" : "dest_base";
			currentState = makeState({
				...currentState,
				location: { ...currentState.location, docked_at: baseId },
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
		refuel: async () => mockApiResponse({}),
		getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
		viewStorage: async () =>
			mockApiResponse({
				action: "view",
				items: [{ item_id: "ore", item_name: "Iron Ore", quantity: 50 }],
			}),
		withdrawFromStorage: async () => {
			currentState = makeState({
				...currentState,
				ship: { ...currentState.ship, cargo_used: 50 },
				cargo: [{ item_id: "ore", item_name: "Iron Ore", quantity: 50, size: 1 }],
			});
			return mockApiResponse({
				action: "withdraw",
				message: "Withdrawn",
			});
		},
		// SellOrDepositCargo at dest: check market first, then sell or deposit
		viewMarket: async () =>
			mockApiResponse({
				action: "view_market",
				base: "Dest Station",
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
		createSellOrder: async () => {
			currentState = makeState({
				...currentState,
				ship: { ...currentState.ship, cargo_used: 0 },
				cargo: [],
			});
			return mockApiResponse({
				action: "create_sell_order",
				message: "Order created",
				quantity_filled: 50,
				quantity_listed: 0,
				total_earned: 250,
			});
		},
		createSellOrdersBulk: async (orders) => {
			const list = orders as Array<{ itemId: string; quantity: number; price: number }>;
			currentState = makeState({
				...currentState,
				ship: { ...currentState.ship, cargo_used: 0 },
				cargo: [],
			});
			return mockApiResponse({
				action: "create_sell_order",
				mode: "bulk",
				results: list.map((_o, i) => ({ index: i, success: true, order_id: `order-${i}` })),
				summary: { succeeded: list.length, failed: 0, total: list.length },
			});
		},
	});

	return {
		endpoints,
		getState: () => currentState,
	};
}

describe("runHaulingLoop", () => {
	test("runs a full load → unload iteration", async () => {
		const mocks = buildCycleMocks();

		const ctx: GoalContext = {
			endpoints: mocks.endpoints,
			state: mocks.getState(),
			refreshState: async () => mocks.getState(),
		};

		const result = await runHaulingLoop(
			{
				source: {
					systemId: "sol",
					poiId: "source_station",
					baseId: "source_base",
					type: "personal-storage",
					items: [{ itemId: "ore", quantity: 50 }],
				},
				destination: {
					systemId: "sol",
					poiId: "dest_station",
					baseId: "dest_base",
					type: "personal-storage",
				},
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

		let iterationsDone = 0;
		const ctx: GoalContext = {
			endpoints: mocks.endpoints,
			state: mocks.getState(),
			refreshState: async () => {
				iterationsDone++;
				if (iterationsDone >= 1) {
					controller.abort();
				}
				return mocks.getState();
			},
		};

		const result = await runHaulingLoop(
			{
				source: {
					systemId: "sol",
					poiId: "source_station",
					baseId: "source_base",
					type: "personal-storage",
					items: [{ itemId: "ore", quantity: 50 }],
				},
				destination: {
					systemId: "sol",
					poiId: "dest_station",
					baseId: "dest_base",
					type: "personal-storage",
				},
				loopOptions: { signal: controller.signal, maxIterations: 10 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBeLessThan(10);
	});
});
