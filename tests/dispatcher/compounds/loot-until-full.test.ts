import { describe, expect, test } from "bun:test";
import { LootUntilFull } from "../../../src/dispatcher/compounds/loot-until-full.js";
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
			poi_id: "belt_1",
			poi_name: "Jettison Zone",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeWreck(id: string, cargoItems: number) {
	return {
		id,
		cargo:
			cargoItems > 0 ? [{ item_id: "iron_ore", quantity: 10 * cargoItems, name: "Iron Ore" }] : [],
		modules: [],
		salvage_value: 100,
		ship_class: "hauler",
		victim_id: "p2",
		victim_name: "Victim",
		created_at: "2026-01-01T00:00:00Z",
		expires_at: "2026-01-01T01:00:00Z",
		expire_tick: 999,
	};
}

describe("LootUntilFull", () => {
	test("already satisfied when cargo is full", async () => {
		const state = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 100,
			},
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const goal = new LootUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("fails when docked", async () => {
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				docked_at: "base1",
			},
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const goal = new LootUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("docked");
	});

	test("fails when neither readLocalState nor refreshState provided", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new LootUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
	});

	test("uses readLocalState instead of refreshState when both provided", async () => {
		let readLocalCalls = 0;
		let refreshStateCalls = 0;
		let cargoUsed = 0;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			getWrecks: async () => mockApiResponse({ count: 1, wrecks: [makeWreck("w1", 3)] }),
			lootWreck: async () => {
				cargoUsed += 50;
				currentState = makeState({
					ship: {
						id: "s1",
						hull: 100,
						max_hull: 100,
						fuel: 50,
						max_fuel: 50,
						cargo_capacity: 100,
						cargo_used: cargoUsed,
					},
				});
				return mockApiResponse({ quantity: 50, wreck_empty: false });
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: makeState(),
			readLocalState: () => {
				readLocalCalls++;
				return currentState;
			},
			refreshState: async () => {
				refreshStateCalls++;
				return currentState;
			},
		};

		const goal = new LootUntilFull();
		await goal.execute(ctx);

		expect(readLocalCalls).toBeGreaterThan(0);
		expect(refreshStateCalls).toBe(0);
	});

	test("succeeds immediately when no wrecks with cargo", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			getWrecks: async () =>
				mockApiResponse({
					count: 1,
					wrecks: [makeWreck("w1", 0)], // no cargo
				}),
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const goal = new LootUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("No wrecks");
	});

	test("loots a wreck until wreck_empty then moves on", async () => {
		let lootCallCount = 0;
		let cargoUsed = 0;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			getWrecks: async () =>
				mockApiResponse({
					count: 1,
					wrecks: [makeWreck("w1", 3)],
				}),
			lootWreck: async () => {
				lootCallCount++;
				cargoUsed += 25;
				currentState = makeState({
					ship: {
						id: "s1",
						hull: 100,
						max_hull: 100,
						fuel: 50,
						max_fuel: 50,
						cargo_capacity: 100,
						cargo_used: cargoUsed,
					},
				});
				return mockApiResponse({ quantity: 25, wreck_empty: lootCallCount >= 3 });
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new LootUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(3);
		expect(lootCallCount).toBe(3);
		expect(result.message).toContain("all available wrecks");
	});

	test("stops when cargo reaches threshold", async () => {
		let cargoUsed = 0;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			getWrecks: async () =>
				mockApiResponse({
					count: 1,
					wrecks: [makeWreck("w1", 10)],
				}),
			lootWreck: async () => {
				cargoUsed += 50;
				currentState = makeState({
					ship: {
						id: "s1",
						hull: 100,
						max_hull: 100,
						fuel: 50,
						max_fuel: 50,
						cargo_capacity: 100,
						cargo_used: cargoUsed,
					},
				});
				return mockApiResponse({ quantity: 50, wreck_empty: false });
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new LootUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2); // 50 + 50 = 100 = full
		expect(result.message).toContain("cargo full");
	});

	test("respects fullThreshold", async () => {
		let cargoUsed = 0;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			getWrecks: async () =>
				mockApiResponse({
					count: 1,
					wrecks: [makeWreck("w1", 10)],
				}),
			lootWreck: async () => {
				cargoUsed += 50;
				currentState = makeState({
					ship: {
						id: "s1",
						hull: 100,
						max_hull: 100,
						fuel: 50,
						max_fuel: 50,
						cargo_capacity: 100,
						cargo_used: cargoUsed,
					},
				});
				return mockApiResponse({ quantity: 50, wreck_empty: false });
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new LootUntilFull({ fullThreshold: 0.5 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1); // 50/100 = 0.5 threshold reached
	});

	test("treats cargo_full API error as success", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			getWrecks: async () =>
				mockApiResponse({
					count: 1,
					wrecks: [makeWreck("w1", 3)],
				}),
			lootWreck: async () => {
				throw new ApiError("cargo_full", "Cargo hold is full", 400);
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const goal = new LootUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("full");
	});

	test("returns failure for non-cargo-full API errors", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			getWrecks: async () =>
				mockApiResponse({
					count: 1,
					wrecks: [makeWreck("w1", 3)],
				}),
			lootWreck: async () => {
				throw new ApiError("not_at_wreck", "You are not near this wreck", 400);
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const goal = new LootUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("Loot failed");
	});

	test("stops at maxAttempts", async () => {
		const currentState = makeState();

		const endpoints = createMockEndpoints({
			getWrecks: async () =>
				mockApiResponse({
					count: 1,
					wrecks: [makeWreck("w1", 10)],
				}),
			lootWreck: async () => {
				// Cargo never fills up, wreck never empties
				return mockApiResponse({ quantity: 1, wreck_empty: false });
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new LootUntilFull({ maxAttempts: 3 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(3);
	});

	test("loots multiple wrecks in sequence", async () => {
		const lootedWrecks: string[] = [];
		let cargoUsed = 0;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			getWrecks: async () =>
				mockApiResponse({
					count: 2,
					wrecks: [makeWreck("w1", 1), makeWreck("w2", 1)],
				}),
			lootWreck: async (wreckId) => {
				lootedWrecks.push(wreckId as string);
				cargoUsed += 10;
				currentState = makeState({
					ship: {
						id: "s1",
						hull: 100,
						max_hull: 100,
						fuel: 50,
						max_fuel: 50,
						cargo_capacity: 100,
						cargo_used: cargoUsed,
					},
				});
				return mockApiResponse({ quantity: 10, wreck_empty: true });
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new LootUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(lootedWrecks).toEqual(["w1", "w2"]);
		expect(result.ticksUsed).toBe(2);
	});

	test("fails when ship state lost after looting", async () => {
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			getWrecks: async () =>
				mockApiResponse({
					count: 1,
					wrecks: [makeWreck("w1", 3)],
				}),
			lootWreck: async () => {
				currentState = makeState({ ship: undefined });
				return mockApiResponse({ quantity: 10, wreck_empty: false });
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new LootUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Ship state lost");
	});

	test("stops looting when the abort signal fires between attempts", async () => {
		const controller = new AbortController();
		let lootCalls = 0;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			getWrecks: async () =>
				mockApiResponse({
					count: 1,
					wrecks: [makeWreck("w1", 10)],
				}),
			lootWreck: async () => {
				lootCalls++;
				// Force abort lands while a loot attempt is in flight — cargo is
				// nowhere near full and the wreck never empties, so only the signal
				// can stop the loop.
				controller.abort();
				currentState = makeState({
					ship: {
						id: "s1",
						hull: 100,
						max_hull: 100,
						fuel: 50,
						max_fuel: 50,
						cargo_capacity: 100,
						cargo_used: 10,
					},
				});
				return mockApiResponse({ quantity: 10, wreck_empty: false });
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: makeState(),
			signal: controller.signal,
			readLocalState: () => currentState,
		};

		const goal = new LootUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(result.ticksUsed).toBe(1);
		expect(lootCalls).toBe(1);
	});
});
