import { describe, expect, test } from "bun:test";
import { MineWithJettison } from "../../../src/dispatcher/compounds/mine-with-jettison.js";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
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

describe("MineWithJettison", () => {
	test("fails when neither readLocalState nor refreshState provided", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new MineWithJettison({ junkItemIds: ["stone"] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
	});

	test("uses readLocalState instead of refreshState when both provided", async () => {
		let readLocalCalls = 0;
		let refreshStateCalls = 0;
		let cargoUsed = 0;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			mine: async () => {
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
					cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: cargoUsed, size: 1 }],
				});
				return mockApiResponse({});
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

		const goal = new MineWithJettison({ junkItemIds: ["stone"] });
		await goal.execute(ctx);

		expect(readLocalCalls).toBeGreaterThan(0);
		expect(refreshStateCalls).toBe(0);
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

		const goal = new MineWithJettison({ junkItemIds: ["stone"] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("docked");
	});

	test("mines until full when no junk in cargo", async () => {
		let cargoUsed = 0;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			mine: async () => {
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
					cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: cargoUsed, size: 1 }],
				});
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new MineWithJettison({ junkItemIds: ["stone"] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(2);
		expect(result.message).toContain("0 jettison round(s)");
	});

	test("mines, jettisons junk, then mines again", async () => {
		let mineCount = 0;
		let jettisonCalls = 0;
		let cargoUsed = 0;
		let hasStone = true;

		let currentState = makeState();

		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			mine: async () => {
				mineCount++;
				if (hasStone) {
					// First round: fills with mix of ore and stone
					cargoUsed = 100;
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
						cargo: [
							{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 60, size: 1 },
							{ item_id: "stone", item_name: "Stone", quantity: 40, size: 1 },
						],
					});
				} else {
					// After jettison: fills with only ore
					cargoUsed = 100;
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
						cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 100, size: 1 }],
					});
				}
				return mockApiResponse({});
			},
			jettison: async () => {
				jettisonCalls++;
				hasStone = false;
				cargoUsed = 60;
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
					cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 60, size: 1 }],
				});
				return mockApiResponse({
					item_id: "stone",
					item_name: "Stone",
					quantity: 40,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new MineWithJettison({ junkItemIds: ["stone"] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(jettisonCalls).toBe(1);
		expect(mineCount).toBe(2);
		expect(result.message).toContain("1 jettison round(s)");
	});

	test("respects maxJettisonRounds", async () => {
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			mine: async () => {
				// Always fills with junk
				currentState = makeState({
					ship: {
						id: "s1",
						hull: 100,
						max_hull: 100,
						fuel: 50,
						max_fuel: 50,
						cargo_capacity: 100,
						cargo_used: 100,
					},
					cargo: [
						{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 50, size: 1 },
						{ item_id: "stone", item_name: "Stone", quantity: 50, size: 1 },
					],
				});
				return mockApiResponse({});
			},
			jettison: async () => {
				// After jettison, partially empty but stone will come back on mine
				currentState = makeState({
					ship: {
						id: "s1",
						hull: 100,
						max_hull: 100,
						fuel: 50,
						max_fuel: 50,
						cargo_capacity: 100,
						cargo_used: 50,
					},
					cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 50, size: 1 }],
				});
				return mockApiResponse({
					item_id: "stone",
					item_name: "Stone",
					quantity: 50,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new MineWithJettison({
			junkItemIds: ["stone"],
			maxJettisonRounds: 2,
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.message).toContain("2 jettison round(s)");
	});

	test("respects maxAttempts across jettison rounds", async () => {
		let mineCount = 0;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			mine: async () => {
				mineCount++;
				// Never fully fills — each mine adds 10
				const used = Math.min(mineCount * 10, 100);
				currentState = makeState({
					ship: {
						id: "s1",
						hull: 100,
						max_hull: 100,
						fuel: 50,
						max_fuel: 50,
						cargo_capacity: 100,
						cargo_used: used,
					},
					cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: used, size: 1 }],
				});
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new MineWithJettison({
			junkItemIds: ["stone"],
			maxAttempts: 5,
		});
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(mineCount).toBeLessThanOrEqual(5);
	});

	test("fails when ship state unknown", async () => {
		const state = makeState({ ship: undefined });
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const goal = new MineWithJettison({ junkItemIds: ["stone"] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("Ship state unknown");
	});

	test("stops mining when the abort signal fires between attempts", async () => {
		const controller = new AbortController();
		let mineCalls = 0;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			mine: async () => {
				mineCalls++;
				// Force abort lands while a mine attempt is in flight — cargo is
				// nowhere near full, so only the signal can stop the loop.
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
					cargo: [{ item_id: "iron_ore", item_name: "Iron Ore", quantity: 10, size: 1 }],
				});
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: makeState(),
			signal: controller.signal,
			readLocalState: () => currentState,
		};

		const goal = new MineWithJettison({ junkItemIds: ["stone"] });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(mineCalls).toBe(1);
	});
});
