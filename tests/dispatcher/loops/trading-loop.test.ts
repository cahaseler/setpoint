import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { runTradingLoop } from "../../../src/dispatcher/loops/trading-loop.js";
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

/**
 * Build mock endpoints that simulate a full buy → sell cycle:
 * - Start docked at buy station
 * - buy() fills cargo
 * - travel to sell station + dock
 * - createSellOrder() clears cargo
 * - travel back to buy station + dock for next iteration
 */
function buildCycleMocks() {
	let currentState = makeState();
	let atBuyStation = true;

	const endpoints = createMockEndpoints({
		getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
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
			if (id === "sell_station") {
				atBuyStation = false;
				currentState = makeState({
					...currentState,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "sell_station",
						poi_name: "Sell Station",
					},
				});
			} else {
				// Travelling back to buy station
				atBuyStation = true;
				currentState = makeState({
					...currentState,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "buy_station",
						poi_name: "Buy Station",
					},
					ship: { ...currentState.ship, cargo_used: 0 },
					cargo: [],
				});
			}
			return mockApiResponse({});
		},
		dock: async () => {
			const baseId = atBuyStation ? "buy_base" : "sell_base";
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
		viewMarket: async () =>
			mockApiResponse({
				action: "view_market",
				base: "Buy Station",
				items: [
					{
						item_id: "goods",
						item_name: "Trade Goods",
						best_buy: 0,
						best_sell: 30,
						buy_price: 0,
						buy_quantity: 0,
						sell_price: 30,
						sell_quantity: 100,
						buy_orders: [],
						sell_orders: [{ price_each: 30, quantity: 100 }],
					},
				],
			}),
		buy: async () => {
			currentState = makeState({
				...currentState,
				ship: { ...currentState.ship, cargo_used: 100 },
				cargo: [{ item_id: "goods", item_name: "Trade Goods", quantity: 100, size: 1 }],
			});
			return mockApiResponse({
				action: "buy",
				item: "Trade Goods",
				item_id: "goods",
				quantity: 100,
				total_cost: 3000,
			});
		},
		createSellOrder: async () => {
			currentState = makeState({
				...currentState,
				ship: { ...currentState.ship, cargo_used: 0 },
				cargo: [],
			});
			return mockApiResponse({
				action: "create_sell_order",
				message: "Order created",
				quantity_filled: 100,
				quantity_listed: 0,
				total_earned: 5000,
			});
		},
	});

	return {
		endpoints,
		getState: () => currentState,
	};
}

describe("runTradingLoop", () => {
	test("runs a full buy → sell iteration", async () => {
		const mocks = buildCycleMocks();

		const ctx: GoalContext = {
			endpoints: mocks.endpoints,
			state: mocks.getState(),
			refreshState: async () => mocks.getState(),
		};

		const result = await runTradingLoop(
			{
				buyStation: {
					systemId: "sol",
					poiId: "buy_station",
					baseId: "buy_base",
				},
				sellStation: {
					systemId: "sol",
					stationPoiId: "sell_station",
					baseId: "sell_base",
				},
				items: [
					{
						itemId: "goods",
						maxBuyPrice: 50,
						minSellPrice: 60,
					},
				],
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

		const result = await runTradingLoop(
			{
				buyStation: {
					systemId: "sol",
					poiId: "buy_station",
					baseId: "buy_base",
				},
				sellStation: {
					systemId: "sol",
					stationPoiId: "sell_station",
					baseId: "sell_base",
				},
				items: [
					{
						itemId: "goods",
						maxBuyPrice: 50,
						minSellPrice: 60,
					},
				],
				loopOptions: { signal: controller.signal, maxIterations: 10 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBeLessThan(10);
	});

	test("respects maxIterations", async () => {
		const mocks = buildCycleMocks();

		const ctx: GoalContext = {
			endpoints: mocks.endpoints,
			state: mocks.getState(),
			refreshState: async () => mocks.getState(),
		};

		const result = await runTradingLoop(
			{
				buyStation: {
					systemId: "sol",
					poiId: "buy_station",
					baseId: "buy_base",
				},
				sellStation: {
					systemId: "sol",
					stationPoiId: "sell_station",
					baseId: "sell_base",
				},
				items: [
					{
						itemId: "goods",
						maxBuyPrice: 50,
						minSellPrice: 60,
					},
				],
				loopOptions: { maxIterations: 2 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
	});
});
