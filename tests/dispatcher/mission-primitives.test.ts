import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../src/dispatcher/goals.js";
import { AbandonMission } from "../../src/dispatcher/primitives/abandon-mission.js";
import { AcceptMission } from "../../src/dispatcher/primitives/accept-mission.js";
import { CompleteMission } from "../../src/dispatcher/primitives/complete-mission.js";
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
			poi_id: "sol_station",
			poi_name: "Station",
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

// ── AcceptMission ────────────────────────────────────────────────────

describe("AcceptMission", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new AcceptMission({ missionId: "m1" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("docked");
	});

	test("accepts mission successfully", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			acceptMission: async () =>
				mockApiResponse({
					mission_id: "m1",
					title: "Deliver Ore",
					type: "delivery",
					expires_at: "2026-02-01T00:00:00Z",
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new AcceptMission({ missionId: "m1" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Deliver Ore");
	});
});

// ── CompleteMission ──────────────────────────────────────────────────

describe("CompleteMission", () => {
	test("completes mission and reports credits", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			completeMission: async () =>
				mockApiResponse({
					mission_id: "m1",
					title: "Deliver Ore",
					credits_earned: 500,
					items_received: {},
					message: "Mission complete!",
					skill_xp_gained: {},
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new CompleteMission({ missionId: "m1" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Deliver Ore");
		expect(result.message).toContain("500 credits");
	});
});

// ── AbandonMission ───────────────────────────────────────────────────

describe("AbandonMission", () => {
	test("abandons mission successfully", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			abandonMission: async () =>
				mockApiResponse({
					mission_id: "m1",
					title: "Deliver Ore",
					message: "Mission abandoned",
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new AbandonMission({ missionId: "m1" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Deliver Ore");
	});
});
