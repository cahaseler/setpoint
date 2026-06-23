import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { runStorageTransferLoop } from "../../../src/dispatcher/loops/storage-transfer-loop.js";
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

describe("storage-transfer-loop", () => {
	test("completes when personal storage is empty on first check", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			viewStorage: async () => mockApiResponse({ items: [], credits: 0 }),
			getState: async () => mockApiResponse({}),
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const result = await runStorageTransferLoop(
			{
				systemId: "sol",
				stationPoiId: "sol_station",
				baseId: "sol_base",
				refuel: false,
			},
			ctx,
		);

		expect(result.success).toBe(true);
		// First iteration: storage empty (alreadySatisfied).
		// shouldContinue stops before iteration 2.
		expect(result.iterationCount).toBe(1);
	});

	test("transfers items and stops when storage becomes empty", async () => {
		const state = makeState();
		let storageCallCount = 0;

		const endpoints = createMockEndpoints({
			viewStorage: async () => {
				storageCallCount++;
				if (storageCallCount === 1) {
					return mockApiResponse({
						items: [{ item_id: "ore", item_name: "Iron Ore", quantity: 50 }],
						credits: 0,
					});
				}
				// Second call: storage is now empty
				return mockApiResponse({ items: [], credits: 0 });
			},
			depositToFactionStorage: async () => mockApiResponse({}),
			getState: async () => mockApiResponse({}),
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const result = await runStorageTransferLoop(
			{
				systemId: "sol",
				stationPoiId: "sol_station",
				baseId: "sol_base",
				refuel: false,
			},
			ctx,
		);

		expect(result.success).toBe(true);
		// Iteration 1: transfers items. Iteration 2: storage empty (alreadySatisfied).
		// shouldContinue stops before iteration 3.
		expect(result.iterationCount).toBe(2);
		expect(storageCallCount).toBe(2);
	});

	test("can be cancelled via abort signal", async () => {
		const state = makeState();
		const controller = new AbortController();

		// Abort immediately
		controller.abort();

		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const result = await runStorageTransferLoop(
			{
				systemId: "sol",
				stationPoiId: "sol_station",
				baseId: "sol_base",
				loopOptions: { signal: controller.signal },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(0);
		expect(result.message).toContain("cancelled");
	});

	test("respects maxIterations", async () => {
		const state = makeState();

		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					items: [{ item_id: "ore", item_name: "Iron Ore", quantity: 9999 }],
					credits: 0,
				}),
			depositToFactionStorage: async () => mockApiResponse({}),
			getState: async () => mockApiResponse({}),
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const result = await runStorageTransferLoop(
			{
				systemId: "sol",
				stationPoiId: "sol_station",
				baseId: "sol_base",
				refuel: false,
				loopOptions: { maxIterations: 2 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
	});
});
