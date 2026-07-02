import { describe, expect, mock, test } from "bun:test";
import { DisposeTowedWreck } from "../../../src/dispatcher/primitives/dispose-towed-wreck.js";
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
			cargo_capacity: 20,
			cargo_used: 0,
		},
		cargo: [],
		location: { system_id: "sol", system_name: "Sol", poi_id: "belt", poi_name: "Belt" },
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	} as StoredGameState;
}

describe("DisposeTowedWreck", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol", poi_id: "belt", poi_name: "Belt" },
		});
		const result = await new DisposeTowedWreck({ disposition: "scrap" }).execute({
			endpoints: createMockEndpoints(),
			state,
		});
		expect(result.success).toBe(false);
		expect(result.message).toContain("docked");
	});

	test("scraps when disposition is scrap", async () => {
		const scrapMock = mock(async () =>
			mockApiResponse({ wreck_id: "w1", total_value: 500, materials: [], stored_at: "yard" }),
		);
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "yard",
				poi_name: "Yard",
				docked_at: "yard-base",
			},
		});
		const result = await new DisposeTowedWreck({ disposition: "scrap" }).execute({
			endpoints: createMockEndpoints({ scrapTowedWreck: scrapMock }),
			state,
		});
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(scrapMock).toHaveBeenCalledTimes(1);
	});

	test("sells when disposition is sell", async () => {
		const sellMock = mock(async () =>
			mockApiResponse({ wreck_id: "w1", total_payout: 800, new_balance: 1800 }),
		);
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "yard",
				poi_name: "Yard",
				docked_at: "yard-base",
			},
		});
		const result = await new DisposeTowedWreck({ disposition: "sell" }).execute({
			endpoints: createMockEndpoints({ sellTowedWreck: sellMock }),
			state,
		});
		expect(result.success).toBe(true);
		expect(sellMock).toHaveBeenCalledTimes(1);
	});

	test("returns PERMANENT failure when scrap rejects for low salvaging skill", async () => {
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
			scrapTowedWreck: async () => {
				throw new ApiError("skill_too_low", "Requires salvaging skill 2", 400);
			},
		});
		const result = await new DisposeTowedWreck({ disposition: "scrap" }).execute({
			endpoints,
			state,
		});
		expect(result.success).toBe(false);
		expect(result.message).toStartWith("PERMANENT:");
	});
});
