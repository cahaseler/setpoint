import { describe, expect, mock, test } from "bun:test";
import { runTowSalvageLoop } from "../../../src/dispatcher/loops/tow-salvage-loop.js";
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
			poi_id: "belt",
			poi_name: "Belt",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("runTowSalvageLoop (fixed)", () => {
	test("processes one wreck then stops when signalled after disposal", async () => {
		const controller = new AbortController();
		let wreckGone = false;
		// Starts at the wreck site (sol/belt) so NavigateToSystem + GoToPoi short-circuit.
		let current = makeState({
			location: { system_id: "sol", system_name: "Sol", poi_id: "belt", poi_name: "Belt" },
		});

		const towWreck = mock(async () => {
			wreckGone = true;
			return mockApiResponse({
				wreck_id: "w1",
				cargo_count: 0,
				module_count: 0,
				speed_penalty: "0%",
			});
		});
		const scrapTowedWreck = mock(async () => {
			// Signal the loop to stop after this wreck is disposed.
			controller.abort();
			return mockApiResponse({ wreck_id: "w1", total_value: 1, materials: [], stored_at: "yard" });
		});

		const endpoints = createMockEndpoints({
			// GoToPoi calls travel(poiId) — move the ship to the requested POI (undocked).
			travel: async (...args: unknown[]) => {
				const poiId = args[0] as string;
				current = makeState({
					location: { system_id: "sol", system_name: "Sol", poi_id: poiId, poi_name: poiId },
				});
				return mockApiResponse({});
			},
			// DockAt calls dock(baseId) — set docked_at so DrainTowedWreck/Dispose see it.
			dock: async (...args: unknown[]) => {
				const baseId = args[0] as string;
				current = makeState({
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "yard",
						poi_name: "Yard",
						docked_at: baseId,
					},
				});
				return mockApiResponse({});
			},
			getWrecks: async () =>
				mockApiResponse(
					wreckGone
						? { count: 0, wrecks: [] }
						: {
								count: 1,
								wrecks: [{ id: "w1", towed_by_player_id: null, cargo: [], modules: [] }],
							},
				),
			towWreck,
			refuel: async () => mockApiResponse({ fuel_now: 50 }),
			lootWreck: async () => mockApiResponse({ quantity: 0, wreck_empty: true }),
			getCargo: async () => mockApiResponse({ cargo: [] }),
			scrapTowedWreck,
		});

		const result = await runTowSalvageLoop(
			{
				mode: "fixed",
				disposition: "scrap",
				wreckSystemId: "sol",
				wreckPoiId: "belt",
				yardSystemId: "sol",
				yardPoiId: "yard",
				yardBaseId: "yard-base",
				loopOptions: { signal: controller.signal, retryDelayMs: 1 },
			},
			{ endpoints, state: current, refreshState: async () => current },
		);

		expect(result.success).toBe(true);
		expect(towWreck).toHaveBeenCalledTimes(1);
		expect(scrapTowedWreck).toHaveBeenCalledTimes(1);
	});

	test("stops on a permanent precondition failure without retrying", async () => {
		const current = makeState({
			location: { system_id: "sol", system_name: "Sol", poi_id: "belt", poi_name: "Belt" },
		});

		const towWreck = mock(async () => {
			throw new ApiError("no_tow_rig", "No tow rig utility module fitted", 400);
		});

		const endpoints = createMockEndpoints({
			getWrecks: async () =>
				mockApiResponse({
					count: 1,
					wrecks: [{ id: "w1", towed_by_player_id: null, cargo: [], modules: [] }],
				}),
			towWreck,
		});

		const result = await runTowSalvageLoop(
			{
				mode: "fixed",
				disposition: "scrap",
				wreckSystemId: "sol",
				wreckPoiId: "belt",
				yardSystemId: "sol",
				yardPoiId: "yard",
				yardBaseId: "yard-base",
				loopOptions: { maxIterations: 5, retryDelayMs: 1 },
			},
			{ endpoints, state: current, refreshState: async () => current },
		);

		// The loop aborted itself (cancellation is reported as success), and the
		// permanent failure was not retried — towWreck ran exactly once.
		expect(result.success).toBe(true);
		expect(towWreck).toHaveBeenCalledTimes(1);
	});
});
