import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../src/dispatcher/goals.js";
import { JettisonCargo } from "../../src/dispatcher/primitives/jettison-cargo.js";
import type { StoredGameState } from "../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../fixtures/mock-endpoints.js";

const DEFAULT_CARGO = [
	{ item_id: "ore", name: "Iron Ore", quantity: 20, size: 1 },
	{ item_id: "junk", name: "Space Junk", quantity: 5, size: 1 },
];

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 1000 },
		ship: { id: "s1", hull: 100, max_hull: 100, fuel: 50, max_fuel: 50 },
		cargo: DEFAULT_CARGO,
		location: { system_id: "sol", system_name: "Sol" },
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function mockGetCargo(
	cargo: Array<{ item_id: string; name: string; quantity: number; size: number }>,
) {
	return async () => mockApiResponse({ cargo });
}

describe("JettisonCargo", () => {
	test("already satisfied when cargo is empty", async () => {
		const state = makeState({ cargo: [] });
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo([]),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new JettisonCargo({ itemId: "ore", quantity: 10 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("already satisfied when item not in cargo", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new JettisonCargo({ itemId: "nonexistent", quantity: 10 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("jettisons specified quantity", async () => {
		let jettisonedQty = 0;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			jettison: async (_itemId, quantity) => {
				jettisonedQty = quantity as number;
				return mockApiResponse({
					container_id: "c1",
					item_id: "ore",
					item_name: "Iron Ore",
					message: "Jettisoned",
					quantity: quantity as number,
				});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new JettisonCargo({ itemId: "ore", quantity: 10 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(jettisonedQty).toBe(10);
	});

	test("clamps quantity to available amount", async () => {
		let jettisonedQty = 0;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: mockGetCargo(DEFAULT_CARGO),
			jettison: async (_itemId, quantity) => {
				jettisonedQty = quantity as number;
				return mockApiResponse({
					container_id: "c1",
					item_id: "ore",
					item_name: "Iron Ore",
					message: "Jettisoned",
					quantity: quantity as number,
				});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		// Request more than available (20 in cargo)
		const goal = new JettisonCargo({ itemId: "ore", quantity: 999 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(jettisonedQty).toBe(20);
	});
});
