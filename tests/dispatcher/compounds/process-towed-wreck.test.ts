import { describe, expect, mock, test } from "bun:test";
import { ProcessTowedWreck } from "../../../src/dispatcher/compounds/process-towed-wreck.js";
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

describe("ProcessTowedWreck", () => {
	test("tows, travels to yard, docks, drains, and scraps", async () => {
		// Initial state: already in the yard system (so NavigateToSystem short-circuits),
		// but at a different POI and not docked.
		let current = makeState({
			location: { system_id: "sol", system_name: "Sol", poi_id: "belt", poi_name: "Belt" },
		});

		const tow = mock(async () => mockApiResponse({}));
		const scrap = mock(async () => mockApiResponse({}));
		const refuel = mock(async () => mockApiResponse({ fuel_now: 50 }));

		const endpoints = createMockEndpoints({
			towWreck: tow,
			// GoToPoi calls travel(poiId) — update current so subsequent refreshes see the new POI.
			travel: async () => {
				current = makeState({
					location: { system_id: "sol", system_name: "Sol", poi_id: "yard", poi_name: "Yard" },
				});
				return mockApiResponse({});
			},
			// DockAt calls dock(baseId) — update current so EnsureFueled and DrainTowedWreck see docked_at.
			// Set fuel below max so EnsureFueled actually calls refuel instead of short-circuiting.
			dock: async () => {
				current = makeState({
					ship: {
						id: "s1",
						hull: 100,
						max_hull: 100,
						fuel: 30,
						max_fuel: 50,
						cargo_capacity: 100,
						cargo_used: 0,
					},
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "yard",
						poi_name: "Yard",
						docked_at: "yard-base",
					},
				});
				return mockApiResponse({});
			},
			refuel,
			// DrainTowedWreck: loot once (wreck_empty immediately), then EnsureEmptyCargo sees empty hold.
			lootWreck: async () => mockApiResponse({ quantity: 0, wreck_empty: true }),
			getCargo: async () => mockApiResponse({ cargo: [] }),
			scrapTowedWreck: scrap,
		});

		const result = await new ProcessTowedWreck({
			wreckId: "w1",
			yardSystemId: "sol",
			yardPoiId: "yard",
			yardBaseId: "yard-base",
			disposition: "scrap",
		}).execute({
			endpoints,
			state: current,
			refreshState: async () => current,
		});

		expect(result.success).toBe(true);
		expect(tow).toHaveBeenCalledWith("w1");
		expect(refuel).toHaveBeenCalledTimes(1);
		expect(scrap).toHaveBeenCalledTimes(1);
	});
});
