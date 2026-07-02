import { describe, expect, mock, test } from "bun:test";
import { DrainTowedWreck } from "../../../src/dispatcher/compounds/drain-towed-wreck.js";
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
			poi_id: "yard",
			poi_name: "Yard",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("DrainTowedWreck", () => {
	test("loots once when the wreck empties in one pass", async () => {
		const loot = mock(async () => mockApiResponse({ quantity: 10, wreck_empty: true }));
		const deposit = mock(async () => mockApiResponse({}));
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "yard",
				poi_name: "Yard",
				docked_at: "yard-base",
			},
		});
		const endpoints = createMockEndpoints({
			lootWreck: loot,
			getCargo: async () => mockApiResponse({ cargo: [{ item_id: "ore", quantity: 10 }] }),
			depositToStorageBulk: deposit,
		});
		const result = await new DrainTowedWreck({ wreckId: "w1", storageTarget: "personal" }).execute({
			endpoints,
			state,
			refreshState: async () => state,
		});
		expect(result.success).toBe(true);
		expect(loot).toHaveBeenCalledTimes(1);
	});

	test("loots repeatedly until wreck_empty (wreck bigger than cargo)", async () => {
		let calls = 0;
		const loot = mock(async () => {
			calls++;
			return mockApiResponse({ quantity: 20, wreck_empty: calls >= 3 });
		});
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "yard",
				poi_name: "Yard",
				docked_at: "yard-base",
			},
		});
		const endpoints = createMockEndpoints({
			lootWreck: loot,
			getCargo: async () => mockApiResponse({ cargo: [{ item_id: "ore", quantity: 20 }] }),
			depositToStorageBulk: async () => mockApiResponse({}),
		});
		const result = await new DrainTowedWreck({ wreckId: "w1" }).execute({
			endpoints,
			state,
			refreshState: async () => state,
		});
		expect(result.success).toBe(true);
		expect(loot).toHaveBeenCalledTimes(3);
	});

	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol", poi_id: "yard", poi_name: "Yard" },
		});
		const result = await new DrainTowedWreck({ wreckId: "w1" }).execute({
			endpoints: createMockEndpoints(),
			state,
		});
		expect(result.success).toBe(false);
		expect(result.message).toContain("docked");
	});

	test("fails when the wreck never empties before the maxDrains cap", async () => {
		const loot = mock(async () => mockApiResponse({ quantity: 5, wreck_empty: false }));
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "yard",
				poi_name: "Yard",
				docked_at: "yard-base",
			},
		});
		const endpoints = createMockEndpoints({
			lootWreck: loot,
			getCargo: async () => mockApiResponse({ cargo: [{ item_id: "ore", quantity: 5 }] }),
			depositToStorageBulk: async () => mockApiResponse({}),
		});
		const result = await new DrainTowedWreck({ wreckId: "w1", maxDrains: 2 }).execute({
			endpoints,
			state,
			refreshState: async () => state,
		});
		expect(result.success).toBe(false);
		expect(result.message).toContain("not empty after 2 passes");
		expect(loot).toHaveBeenCalledTimes(2);
	});

	test("routes deposits to faction storage when storageTarget is faction", async () => {
		const personalDeposit = mock(async () => mockApiResponse({}));
		const factionDeposit = mock(async () => mockApiResponse({}));
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "yard",
				poi_name: "Yard",
				docked_at: "yard-base",
			},
		});
		const endpoints = createMockEndpoints({
			lootWreck: async () => mockApiResponse({ quantity: 10, wreck_empty: true }),
			getCargo: async () => mockApiResponse({ cargo: [{ item_id: "ore", quantity: 10 }] }),
			depositToStorageBulk: personalDeposit,
			depositToFactionStorageBulk: factionDeposit,
		});
		const result = await new DrainTowedWreck({ wreckId: "w1", storageTarget: "faction" }).execute({
			endpoints,
			state,
			refreshState: async () => state,
		});
		expect(result.success).toBe(true);
		expect(factionDeposit).toHaveBeenCalledTimes(1);
		expect(personalDeposit).not.toHaveBeenCalled();
	});
});
