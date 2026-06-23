import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { TransferStorage } from "../../../src/dispatcher/primitives/index.js";
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
			system_id: "sol_star",
			system_name: "Sol Star",
			poi_id: "sol_central",
			poi_name: "Sol Central",
			docked_at: "confederacy_central_command",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("TransferStorage", () => {
	test("throws when source and target are the same", () => {
		expect(
			() => new TransferStorage({ source: "self", target: "self", itemId: "iron_ore" }),
		).toThrow();
		expect(
			() => new TransferStorage({ source: "faction", target: "faction", itemId: "iron_ore" }),
		).toThrow();
	});

	test("fails when not docked", async () => {
		const state = makeState({ location: { system_id: "sol_star", system_name: "Sol Star" } });
		const ctx: GoalContext = { endpoints: createMockEndpoints(), state };

		const goal = new TransferStorage({ source: "self", target: "faction", itemId: "iron_ore" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("returns alreadySatisfied when item not in source storage (self)", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			viewStorage: async () => mockApiResponse({ action: "view", items: [], credits: 0 }),
		});
		const ctx: GoalContext = { endpoints, state };

		const result = await new TransferStorage({
			source: "self",
			target: "faction",
			itemId: "iron_ore",
		}).execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.message).toContain("iron_ore");
	});

	test("returns alreadySatisfied when item not in source storage (faction)", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			viewFactionStorage: async () => mockApiResponse({ action: "view", items: [], credits: 0 }),
		});
		const ctx: GoalContext = { endpoints, state };

		const result = await new TransferStorage({
			source: "faction",
			target: "self",
			itemId: "iron_ore",
		}).execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("self → faction: deposits with source='storage'", async () => {
		const state = makeState();
		let capturedSource: string | undefined;
		let capturedQuantity = 0;
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 200, size: 1 }],
				}),
			depositToFactionStorage: async (_itemId: unknown, quantity: unknown, source: unknown) => {
				capturedSource = source as string;
				capturedQuantity = quantity as number;
				return mockApiResponse({ action: "deposit", message: "Deposited" });
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const result = await new TransferStorage({
			source: "self",
			target: "faction",
			itemId: "iron_ore",
			quantity: 100,
		}).execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(capturedSource).toBe("storage");
		expect(capturedQuantity).toBe(100);
	});

	test("faction → self: deposits with source='faction'", async () => {
		const state = makeState();
		let capturedSource: string | undefined;
		let capturedQuantity = 0;
		const endpoints = createMockEndpoints({
			viewFactionStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 300, size: 1 }],
				}),
			depositToStorage: async (_itemId: unknown, quantity: unknown, source: unknown) => {
				capturedSource = source as string;
				capturedQuantity = quantity as number;
				return mockApiResponse({ action: "deposit", message: "Deposited" });
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const result = await new TransferStorage({
			source: "faction",
			target: "self",
			itemId: "iron_ore",
			quantity: 500,
		}).execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(capturedSource).toBe("faction");
		// Caps at available (300) since 500 > 300
		expect(capturedQuantity).toBe(300);
	});

	test("transfers all available when quantity is not specified", async () => {
		const state = makeState();
		let transferredQuantity = 0;
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "copper_ore", item_name: "Copper Ore", quantity: 75, size: 1 }],
				}),
			depositToFactionStorage: async (_itemId: unknown, quantity: unknown) => {
				transferredQuantity = quantity as number;
				return mockApiResponse({ action: "deposit", message: "Deposited" });
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const result = await new TransferStorage({
			source: "self",
			target: "faction",
			itemId: "copper_ore",
		}).execute(ctx);

		expect(result.success).toBe(true);
		expect(transferredQuantity).toBe(75);
	});

	test("transfers credits from faction to self", async () => {
		const state = makeState();
		let transferredItemId = "";
		let transferredQuantity = 0;
		const endpoints = createMockEndpoints({
			viewFactionStorage: async () =>
				mockApiResponse({ action: "view", items: [], credits: 10000 }),
			depositToStorage: async (itemId: unknown, quantity: unknown) => {
				transferredItemId = itemId as string;
				transferredQuantity = quantity as number;
				return mockApiResponse({ action: "deposit", message: "Deposited" });
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const result = await new TransferStorage({
			source: "faction",
			target: "self",
			itemId: "credits",
			quantity: 5000,
		}).execute(ctx);

		expect(result.success).toBe(true);
		expect(transferredItemId).toBe("credits");
		expect(transferredQuantity).toBe(5000);
	});
});
