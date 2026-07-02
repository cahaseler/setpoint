import { describe, expect, mock, test } from "bun:test";
import { TowWreck } from "../../../src/dispatcher/primitives/tow-wreck.js";
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

describe("TowWreck", () => {
	test("tows the wreck and succeeds", async () => {
		const towMock = mock(async () =>
			mockApiResponse({ wreck_id: "w1", cargo_count: 3, module_count: 1, speed_penalty: "50%" }),
		);
		const endpoints = createMockEndpoints({ towWreck: towMock });
		const result = await new TowWreck("w1").execute({ endpoints, state: makeState() });
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(towMock).toHaveBeenCalledWith("w1");
	});

	test("returns a PERMANENT failure when no tow-rig is fitted", async () => {
		const endpoints = createMockEndpoints({
			towWreck: async () => {
				throw new ApiError("no_tow_rig", "No tow rig utility module fitted", 400);
			},
		});
		const result = await new TowWreck("w1").execute({ endpoints, state: makeState() });
		expect(result.success).toBe(false);
		expect(result.message).toStartWith("PERMANENT:");
	});

	test("is already-satisfied when already towing the target wreck", async () => {
		const endpoints = createMockEndpoints({
			towWreck: async () => {
				throw new ApiError("already_towing", "You are already towing a wreck", 400);
			},
		});
		const result = await new TowWreck("w1").execute({ endpoints, state: makeState() });
		expect(result.alreadySatisfied).toBe(true);
	});
});
