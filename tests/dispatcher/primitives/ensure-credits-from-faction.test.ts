import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { EnsureCreditsFromFaction } from "../../../src/dispatcher/primitives/index.js";
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
			cargo_used: 10,
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

describe("EnsureCreditsFromFaction", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
			player: { id: "p1", username: "Test", credits: 100 },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new EnsureCreditsFromFaction({ minCredits: 500 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("must be docked");
	});

	test("already satisfied when credits >= threshold", async () => {
		const state = makeState({
			player: { id: "p1", username: "Test", credits: 5000 },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new EnsureCreditsFromFaction({ minCredits: 1000 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("already satisfied when credits >= default threshold (1000)", async () => {
		const state = makeState({
			player: { id: "p1", username: "Test", credits: 1000 },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new EnsureCreditsFromFaction();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("already satisfied when credits low but no credits in faction storage", async () => {
		const state = makeState({
			player: { id: "p1", username: "Test", credits: 100 },
		});
		const endpoints = createMockEndpoints({
			viewFactionStorage: async () =>
				mockApiResponse({
					items: [{ item_id: "ore", item_name: "Iron Ore", quantity: 50 }],
					credits: 0,
				}),
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new EnsureCreditsFromFaction({ minCredits: 500 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.message).toContain("no credits in faction storage");
	});

	test("withdraws credits from faction storage when below threshold", async () => {
		const state = makeState({
			player: { id: "p1", username: "Test", credits: 200 },
		});

		let withdrawnItemId = "";
		let withdrawnQuantity = 0;
		const endpoints = createMockEndpoints({
			viewFactionStorage: async () =>
				mockApiResponse({
					items: [],
					credits: 5000,
				}),
			withdrawFromFactionStorage: async (itemId: unknown, quantity: unknown) => {
				withdrawnItemId = itemId as string;
				withdrawnQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new EnsureCreditsFromFaction({ minCredits: 1000 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(withdrawnItemId).toBe("credits");
		// Needs 800 to reach 1000 threshold, faction has 5000
		expect(withdrawnQuantity).toBe(800);
	});

	test("caps withdrawal to available faction credits", async () => {
		const state = makeState({
			player: { id: "p1", username: "Test", credits: 200 },
		});

		let withdrawnQuantity = 0;
		const endpoints = createMockEndpoints({
			viewFactionStorage: async () =>
				mockApiResponse({
					items: [],
					credits: 300,
				}),
			withdrawFromFactionStorage: async (_itemId: unknown, quantity: unknown) => {
				withdrawnQuantity = quantity as number;
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new EnsureCreditsFromFaction({ minCredits: 1000 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		// Needs 800 but only 300 available — withdraw 300
		expect(withdrawnQuantity).toBe(300);
	});

	test("uses refreshState to get current credit balance", async () => {
		const staleState = makeState({
			player: { id: "p1", username: "Test", credits: 100 },
		});
		const freshState = makeState({
			player: { id: "p1", username: "Test", credits: 5000 },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state: staleState, refreshState: async () => freshState };

		const goal = new EnsureCreditsFromFaction({ minCredits: 1000 });
		const result = await goal.execute(ctx);

		// Fresh state has 5000 credits, so already satisfied
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});
});
