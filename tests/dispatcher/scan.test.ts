import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../src/dispatcher/goals.js";
import { Scan } from "../../src/dispatcher/primitives/scan.js";
import type { StoredGameState } from "../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../fixtures/mock-endpoints.js";

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 1000 },
		ship: { id: "s1", hull: 100, max_hull: 100, fuel: 50, max_fuel: 50 },
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

describe("Scan", () => {
	test("fails when docked", async () => {
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol_station",
				poi_name: "Station",
				docked_at: "sol_base",
			},
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new Scan();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("undocked");
		expect(result.ticksUsed).toBe(0);
	});

	test("scans successfully and reports revealed info", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			scan: async () =>
				mockApiResponse({
					success: true,
					target_id: "target-1",
					revealed_info: ["ship_class", "hull"],
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new Scan();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("2 info revealed");
	});

	test("returns failure when scan fails", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			scan: async () =>
				mockApiResponse({
					success: false,
					target_id: "",
					revealed_info: [],
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new Scan();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(1);
	});
});
