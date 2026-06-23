import { describe, expect, test } from "bun:test";
import { TransferStorageToFaction } from "../../../src/dispatcher/compounds/index.js";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
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
			cargo_capacity: 100,
			cargo_used: 0,
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

describe("TransferStorageToFaction", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new TransferStorageToFaction();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("must be docked");
	});

	test("already satisfied when personal storage is empty", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					items: [],
					credits: 0,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new TransferStorageToFaction();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("empty");
	});

	test("deposits items directly from personal to faction storage", async () => {
		const state = makeState();

		const deposits: Array<{ itemId: string; quantity: number; source: string }> = [];
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					items: [
						{ item_id: "ore", item_name: "Iron Ore", quantity: 50 },
						{ item_id: "gems", item_name: "Gems", quantity: 20 },
					],
					credits: 0,
				}),
			depositToFactionStorage: async (itemId: unknown, quantity: unknown, source: unknown) => {
				deposits.push({
					itemId: itemId as string,
					quantity: quantity as number,
					source: source as string,
				});
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new TransferStorageToFaction();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(deposits).toHaveLength(2);
		expect(deposits[0]).toEqual({ itemId: "ore", quantity: 50, source: "storage" });
		expect(deposits[1]).toEqual({ itemId: "gems", quantity: 20, source: "storage" });
	});

	test("transfers credits directly from personal to faction storage", async () => {
		const state = makeState();

		const deposits: Array<{ itemId: string; quantity: number; source: string }> = [];
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					items: [],
					credits: 5000,
				}),
			depositToFactionStorage: async (itemId: unknown, quantity: unknown, source: unknown) => {
				deposits.push({
					itemId: itemId as string,
					quantity: quantity as number,
					source: source as string,
				});
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new TransferStorageToFaction();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(deposits).toEqual([{ itemId: "credits", quantity: 5000, source: "storage" }]);
	});

	test("transfers both items and credits", async () => {
		const state = makeState();

		const deposits: Array<{ itemId: string; quantity: number; source: string }> = [];
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					items: [{ item_id: "ore", item_name: "Iron Ore", quantity: 100 }],
					credits: 2000,
				}),
			depositToFactionStorage: async (itemId: unknown, quantity: unknown, source: unknown) => {
				deposits.push({
					itemId: itemId as string,
					quantity: quantity as number,
					source: source as string,
				});
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new TransferStorageToFaction();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		// Items first, then credits
		expect(deposits).toHaveLength(2);
		expect(deposits[0]).toEqual({ itemId: "ore", quantity: 100, source: "storage" });
		expect(deposits[1]).toEqual({ itemId: "credits", quantity: 2000, source: "storage" });
	});

	test("skips items at faction storage cap and returns alreadySatisfied", async () => {
		const state = makeState();

		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					items: [{ item_id: "ore_ice_water", item_name: "Ice Water", quantity: 50000 }],
					credits: 0,
				}),
			depositToFactionStorage: async () => {
				throw new ApiError(
					"storage_cap",
					"Faction storage cap reached: already has 100000 of ore_ice_water (cap: 100000)",
					400,
				);
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new TransferStorageToFaction();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.message).toContain("at faction storage cap");
	});

	test("transfers partial amount when faction storage is near cap", async () => {
		const state = makeState();

		const deposits: Array<{ itemId: string; quantity: number; source: string }> = [];
		let callCount = 0;
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					items: [{ item_id: "ore_ice_water", item_name: "Ice Water", quantity: 50000 }],
					credits: 0,
				}),
			depositToFactionStorage: async (itemId: unknown, quantity: unknown, source: unknown) => {
				callCount++;
				if (callCount === 1) {
					// First attempt with full quantity fails — near cap
					throw new ApiError(
						"storage_cap",
						"Faction storage cap reached: already has 67912 of ore_ice_water (cap: 100000)",
						400,
					);
				}
				// Retry with reduced quantity succeeds
				deposits.push({
					itemId: itemId as string,
					quantity: quantity as number,
					source: source as string,
				});
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new TransferStorageToFaction();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(deposits).toHaveLength(1);
		// Should transfer remaining capacity: 100000 - 67912 = 32088
		expect(deposits[0]).toEqual({
			itemId: "ore_ice_water",
			quantity: 32088,
			source: "storage",
		});
		expect(result.steps[0]?.result.message).toContain("capped");
	});

	test("continues transferring other items when one is at cap", async () => {
		const state = makeState();

		const deposits: Array<{ itemId: string; quantity: number; source: string }> = [];
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					items: [
						{ item_id: "ore_ice_water", item_name: "Ice Water", quantity: 50000 },
						{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 200 },
					],
					credits: 1000,
				}),
			depositToFactionStorage: async (itemId: unknown, quantity: unknown, source: unknown) => {
				if (itemId === "ore_ice_water") {
					throw new ApiError(
						"storage_cap",
						"Faction storage cap reached: already has 100000 of ore_ice_water (cap: 100000)",
						400,
					);
				}
				deposits.push({
					itemId: itemId as string,
					quantity: quantity as number,
					source: source as string,
				});
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new TransferStorageToFaction();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		// ore_ice_water skipped, iron_ore and credits transferred
		expect(deposits).toHaveLength(2);
		expect(deposits[0]).toEqual({ itemId: "iron_ore", quantity: 200, source: "storage" });
		expect(deposits[1]).toEqual({ itemId: "credits", quantity: 1000, source: "storage" });
		expect(result.message).toContain("at cap");
	});

	test("all items at cap returns alreadySatisfied", async () => {
		const state = makeState();

		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					items: [
						{ item_id: "ore_ice_water", item_name: "Ice Water", quantity: 50000 },
						{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 200 },
					],
					credits: 0,
				}),
			depositToFactionStorage: async (itemId: unknown) => {
				if (itemId === "ore_ice_water") {
					throw new ApiError(
						"storage_cap",
						"Faction storage cap reached: already has 100000 of ore_ice_water (cap: 100000)",
						400,
					);
				}
				throw new ApiError(
					"storage_cap",
					"Faction storage cap reached: already has 50000 of iron_ore (cap: 50000)",
					400,
				);
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new TransferStorageToFaction();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.message).toContain("at faction storage cap");
	});

	test("excludeCredits skips credit transfer", async () => {
		const state = makeState();

		const deposits: Array<{ itemId: string; quantity: number; source: string }> = [];
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					items: [{ item_id: "ore", item_name: "Iron Ore", quantity: 100 }],
					credits: 5000,
				}),
			depositToFactionStorage: async (itemId: unknown, quantity: unknown, source: unknown) => {
				deposits.push({
					itemId: itemId as string,
					quantity: quantity as number,
					source: source as string,
				});
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new TransferStorageToFaction({ excludeCredits: true });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(deposits).toHaveLength(1);
		expect(deposits[0]).toEqual({ itemId: "ore", quantity: 100, source: "storage" });
		// Credits should not appear in deposits
	});

	test("stops transferring when the abort signal fires between items", async () => {
		const state = makeState();
		const controller = new AbortController();
		const deposits: Array<{ itemId: string; quantity: number }> = [];
		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					items: [
						{ item_id: "ore", item_name: "Iron Ore", quantity: 50 },
						{ item_id: "gems", item_name: "Gems", quantity: 20 },
					],
					credits: 0,
				}),
			depositToFactionStorage: async (itemId: unknown, quantity: unknown) => {
				deposits.push({ itemId: itemId as string, quantity: quantity as number });
				// Force abort lands while the first item is being transferred — there
				// is another item queued, so only the signal can stop the loop.
				controller.abort();
				return mockApiResponse({});
			},
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			signal: controller.signal,
			refreshState: async () => state,
		};

		const goal = new TransferStorageToFaction();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(deposits).toHaveLength(1);
	});

	test("rethrows non-cap ApiErrors", async () => {
		const state = makeState();

		const endpoints = createMockEndpoints({
			viewStorage: async () =>
				mockApiResponse({
					items: [{ item_id: "ore", item_name: "Iron Ore", quantity: 50 }],
					credits: 0,
				}),
			depositToFactionStorage: async () => {
				throw new ApiError("server_error", "Internal server error", 500);
			},
		});
		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const goal = new TransferStorageToFaction();
		await expect(goal.execute(ctx)).rejects.toThrow("Internal server error");
	});
});
