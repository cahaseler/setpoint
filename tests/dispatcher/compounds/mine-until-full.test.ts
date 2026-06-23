import { describe, expect, test } from "bun:test";
import { MineUntilFull } from "../../../src/dispatcher/compounds/mine-until-full.js";
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

describe("MineUntilFull", () => {
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

		const goal = new MineUntilFull();
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

		const goal = new MineUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("docked");
	});

	test("fails when neither readLocalState nor refreshState provided", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new MineUntilFull();
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

		const goal = new MineUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(readLocalCalls).toBeGreaterThan(0);
		expect(refreshStateCalls).toBe(0);
	});

	test("falls back to refreshState when readLocalState not provided", async () => {
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
				});
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: makeState(),
			refreshState: async () => {
				refreshStateCalls++;
				return currentState;
			},
		};

		const goal = new MineUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(refreshStateCalls).toBeGreaterThan(0);
	});

	test("mines until cargo reaches threshold", async () => {
		let cargoUsed = 0;
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			mine: async () => {
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
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new MineUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(4);
	});

	test("respects custom fullThreshold", async () => {
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
				});
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new MineUntilFull({ fullThreshold: 0.5 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
	});

	test("stops at maxAttempts", async () => {
		const currentState = makeState();

		const endpoints = createMockEndpoints({
			mine: async () => {
				// Cargo never fills up
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new MineUntilFull({ maxAttempts: 3 });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(3);
		expect(result.message).toContain("max attempts");
	});

	test("treats cargo-full API error as success", async () => {
		// Local state shows cargo not full, but mine() rejects because cargo is actually full
		const fullState = makeState({
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

		const endpoints = createMockEndpoints({
			mine: async () => {
				throw new ApiError("cargo_full", "Cargo hold is full", 400);
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: makeState(), // stale state shows cargo not full
			refreshState: async () => fullState, // fresh state shows full
		};

		const goal = new MineUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("full");
	});

	test("returns failure for non-cargo-full API errors", async () => {
		const endpoints = createMockEndpoints({
			mine: async () => {
				throw new ApiError("not_at_mine", "Nothing to mine here", 400);
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: makeState(),
			refreshState: async () => makeState(),
		};

		const goal = new MineUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("Mine rejected");
	});

	test("treats cargo_full error as success even when local cargo not at threshold", async () => {
		// Bug fix: 149/150 local cargo doesn't pass threshold=1.0, but game rejects with cargo_full
		const nearFullState = makeState({
			ship: {
				id: "s1",
				hull: 100,
				max_hull: 100,
				fuel: 50,
				max_fuel: 50,
				cargo_capacity: 150,
				cargo_used: 149,
			},
		});

		const endpoints = createMockEndpoints({
			mine: async () => {
				throw new ApiError("cargo_full", "Cargo hold is full", 400);
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: nearFullState,
			refreshState: async () => nearFullState,
		};

		const goal = new MineUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("full");
	});

	test("fails when ship state lost after mining", async () => {
		let currentState = makeState();

		const endpoints = createMockEndpoints({
			mine: async () => {
				currentState = makeState({ ship: undefined });
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new MineUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("Ship state lost");
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

		const goal = new MineUntilFull();
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(result.ticksUsed).toBe(1);
		expect(mineCalls).toBe(1);
	});
});
