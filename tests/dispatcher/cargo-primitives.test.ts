import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../src/dispatcher/goals.js";
import { EnsureEmptyCargo, LoadFromStorage } from "../../src/dispatcher/primitives/index.js";
import type { StoredGameState } from "../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../fixtures/mock-endpoints.js";

const DEFAULT_CARGO = [
	{ item_id: "ore", name: "Ore", quantity: 10, size: 1 },
	{ item_id: "fuel_cell", name: "Fuel Cell", quantity: 5, size: 2 },
];

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
			cargo_used: 20,
		},
		cargo: DEFAULT_CARGO,
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

describe("EnsureEmptyCargo", () => {
	test("already satisfied when cargo is empty", async () => {
		const state = makeState({ cargo: [] });
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new EnsureEmptyCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("already satisfied when cargo is undefined", async () => {
		const state = makeState({ cargo: undefined });
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new EnsureEmptyCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new EnsureEmptyCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("must be docked");
	});

	test("bulk-deposits all cargo items to storage in one tick", async () => {
		let deposited: Array<{ itemId: string; quantity: number }> | undefined;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: DEFAULT_CARGO }),
			depositToStorageBulk: async (items: unknown) => {
				deposited = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: deposited.length,
					succeeded: deposited.length,
					failed: 0,
					results: deposited.map((it) => ({
						item_id: it.itemId,
						quantity: it.quantity,
						success: true,
					})),
				});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new EnsureEmptyCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(deposited).toEqual([
			{ itemId: "ore", quantity: 10 },
			{ itemId: "fuel_cell", quantity: 5 },
		]);
	});

	test("bulk-deposits to faction storage when depositTarget is faction", async () => {
		let deposited: Array<{ itemId: string; quantity: number }> | undefined;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: DEFAULT_CARGO }),
			depositToFactionStorageBulk: async (items: unknown) => {
				deposited = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: deposited.length,
					succeeded: deposited.length,
					failed: 0,
					results: deposited.map((it) => ({
						item_id: it.itemId,
						quantity: it.quantity,
						success: true,
					})),
				});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new EnsureEmptyCargo({ depositTarget: "faction" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(deposited).toEqual([
			{ itemId: "ore", quantity: 10 },
			{ itemId: "fuel_cell", quantity: 5 },
		]);
		expect(result.message).toContain("faction storage");
	});

	test("does not deposit when the abort signal is already set", async () => {
		const controller = new AbortController();
		controller.abort();
		let depositCalled = false;
		const state = makeState();
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: DEFAULT_CARGO }),
			depositToStorageBulk: async (items: unknown) => {
				depositCalled = true;
				return mockApiResponse({
					action: "deposit",
					requested: (items as unknown[]).length,
					succeeded: (items as unknown[]).length,
					failed: 0,
					results: [],
				});
			},
		});
		const ctx: GoalContext = { endpoints, state, signal: controller.signal };

		const goal = new EnsureEmptyCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(depositCalled).toBe(false);
	});

	test("skips items with zero quantity", async () => {
		const mixedCargo = [
			{ item_id: "ore", name: "Ore", quantity: 0, size: 1 },
			{ item_id: "gem", name: "Gem", quantity: 3, size: 1 },
		];
		const state = makeState({ cargo: mixedCargo });
		let deposited: Array<{ itemId: string; quantity: number }> | undefined;
		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: mixedCargo }),
			depositToStorageBulk: async (items: unknown) => {
				deposited = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: deposited.length,
					succeeded: deposited.length,
					failed: 0,
					results: deposited.map((it) => ({
						item_id: it.itemId,
						quantity: it.quantity,
						success: true,
					})),
				});
			},
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new EnsureEmptyCargo();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(deposited?.map((d) => d.itemId)).toEqual(["gem"]);
	});
});

describe("LoadFromStorage", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new LoadFromStorage("ore");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("must be docked");
	});

	test("already satisfied when cargo has enough of the item", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		// Cargo has 10 ore, requesting max of 10
		const goal = new LoadFromStorage("ore", 10);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("fails when cargo info is unknown", async () => {
		const state = makeState({ ship: undefined });
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new LoadFromStorage("ore");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("ship cargo info unknown");
	});

	test("returns alreadySatisfied when cargo is full", async () => {
		const state = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 20,
				cargo_used: 20,
			},
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new LoadFromStorage("gems");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.message).toContain("full");
	});

	test("returns alreadySatisfied when item not in storage", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "gems", item_name: "Gems", quantity: 50, size: 1 }],
				}),
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new LoadFromStorage("ore");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.message).toContain("No ore available in storage");
	});

	test("withdraws from storage respecting cargo space", async () => {
		const state = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 70,
			},
			cargo: [],
		});

		let withdrawnQuantity = 0;
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "ore", item_name: "Ore", quantity: 500, size: 1 }],
				}),
			withdrawFromStorage: async (_itemId: unknown, quantity: unknown) => {
				withdrawnQuantity = quantity as number;
				return mockApiResponse({ action: "withdraw", message: "Withdrawn" });
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new LoadFromStorage("ore");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		// Free space is 30, storage has 500, so should withdraw 30
		expect(withdrawnQuantity).toBe(30);
	});

	test("respects maxQuantity limit", async () => {
		const state = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 0,
			},
			cargo: [{ item_id: "ore", item_name: "Ore", quantity: 5, size: 1 }],
		});

		let withdrawnQuantity = 0;
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "ore", item_name: "Ore", quantity: 500, size: 1 }],
				}),
			withdrawFromStorage: async (_itemId: unknown, quantity: unknown) => {
				withdrawnQuantity = quantity as number;
				return mockApiResponse({ action: "withdraw", message: "Withdrawn" });
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		// Already have 5, want max 20 → withdraw 15
		const goal = new LoadFromStorage("ore", 20);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(withdrawnQuantity).toBe(15);
	});

	test("limits by storage quantity when storage has less", async () => {
		const state = makeState({
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
		});

		let withdrawnQuantity = 0;
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "ore", item_name: "Ore", quantity: 8, size: 1 }],
				}),
			withdrawFromStorage: async (_itemId: unknown, quantity: unknown) => {
				withdrawnQuantity = quantity as number;
				return mockApiResponse({ action: "withdraw", message: "Withdrawn" });
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		// Want 50 but only 8 in storage
		const goal = new LoadFromStorage("ore", 50);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(withdrawnQuantity).toBe(8);
	});

	test("loads unlimited when no maxQuantity specified", async () => {
		const state = makeState({
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
		});

		let withdrawnQuantity = 0;
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "ore", item_name: "Ore", quantity: 200, size: 1 }],
				}),
			withdrawFromStorage: async (_itemId: unknown, quantity: unknown) => {
				withdrawnQuantity = quantity as number;
				return mockApiResponse({ action: "withdraw", message: "Withdrawn" });
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		// No maxQuantity → load as much as fits (100 capacity, 0 used)
		const goal = new LoadFromStorage("ore");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(withdrawnQuantity).toBe(100);
	});

	test("respects item size when computing how many fit", async () => {
		const state = makeState({
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
		});

		let withdrawnQuantity = 0;
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					// Item size 4 — only 25 fit in a 100-unit hold
					items: [{ item_id: "heavy_ore", item_name: "Heavy Ore", quantity: 200, size: 4 }],
				}),
			withdrawFromStorage: async (_itemId: unknown, quantity: unknown) => {
				withdrawnQuantity = quantity as number;
				return mockApiResponse({ action: "withdraw", message: "Withdrawn" });
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new LoadFromStorage("heavy_ore");
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// 100 capacity / size 4 = 25 items max
		expect(withdrawnQuantity).toBe(25);
	});

	test("succeeds when ctx.state is stale but refreshState shows empty cargo", async () => {
		// Stale state shows cargo full (cargo_used = 450), fresh state shows empty (cargo_used = 0)
		const staleState = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 450,
				cargo_used: 450,
			},
			cargo: [],
		});
		const freshState = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 450,
				cargo_used: 0,
			},
			cargo: [],
		});

		let withdrawnQuantity = 0;
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "ore_crystal", item_name: "Ore Crystal", quantity: 450, size: 1 }],
				}),
			withdrawFromStorage: async (_itemId: unknown, quantity: unknown) => {
				withdrawnQuantity = quantity as number;
				return mockApiResponse({ action: "withdraw", message: "Withdrawn" });
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state: staleState,
			refreshState: async () => freshState,
		};

		const goal = new LoadFromStorage("ore_crystal", 450);
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(withdrawnQuantity).toBe(450);
	});
});
