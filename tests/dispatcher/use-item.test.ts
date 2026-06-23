import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../src/dispatcher/goals.js";
import { UseItem } from "../../src/dispatcher/primitives/use-item.js";
import type { StoredGameState } from "../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../fixtures/mock-endpoints.js";

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 1000 },
		ship: { id: "s1", hull: 100, max_hull: 100, fuel: 50, max_fuel: 50 },
		cargo: [{ item_id: "repair_kit", item_name: "Repair Kit", quantity: 3, size: 1 }],
		location: { system_id: "sol", system_name: "Sol" },
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("UseItem", () => {
	test("already satisfied when item not in cargo", async () => {
		const state = makeState({ cargo: [] });
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new UseItem({ itemId: "repair_kit" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("uses item and reports effect", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "repair_kit", name: "Repair Kit", quantity: 3, size: 1 }],
				}),
			useItem: async () =>
				mockApiResponse({
					action: "use_item",
					effect_type: "repair",
					item_id: "repair_kit",
					item_name: "Repair Kit",
					quantity_used: 1,
					quantity_remaining: 2,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new UseItem({ itemId: "repair_kit" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Repair Kit");
		expect(result.message).toContain("repair");
		expect(result.message).toContain("2 remaining");
	});

	test("already satisfied when item quantity is zero", async () => {
		const state = makeState({
			cargo: [{ item_id: "repair_kit", item_name: "Repair Kit", quantity: 0, size: 1 }],
		});
		const endpoints = createMockEndpoints({
			getCargo: async () =>
				mockApiResponse({
					cargo: [{ item_id: "repair_kit", name: "Repair Kit", quantity: 0, size: 1 }],
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new UseItem({ itemId: "repair_kit" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});
});
