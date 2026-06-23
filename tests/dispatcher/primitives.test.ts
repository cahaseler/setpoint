import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../src/dispatcher/goals.js";
import {
	DockAt,
	EnsureFueled,
	EnsureRepaired,
	EnsureUndocked,
	GoToPoi,
	NavigateToSystem,
} from "../../src/dispatcher/primitives/index.js";
import type { StoredGameState } from "../../src/state/store.js";
import { ApiError } from "../../src/util/errors.js";
import { createMockEndpoints, mockApiResponse } from "../fixtures/mock-endpoints.js";

/** Build a minimal StoredGameState for testing. */
function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 1000, empire: "solarian" },
		ship: {
			id: "s1",
			class_id: "scout",
			hull: 100,
			max_hull: 100,
			fuel: 50,
			max_fuel: 50,
		},
		cargo: [],
		location: {
			system_id: "sol",
			system_name: "Sol",
			poi_id: "sol-station",
			poi_name: "Sol Station",
			poi_type: "station",
			docked_at: "sol-station",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

// ─── NavigateToSystem ──────────────────────────────────────────────

describe("NavigateToSystem", () => {
	test("already satisfied when in target system", async () => {
		const goal = new NavigateToSystem("sol");
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state: makeState(),
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("fails when location unknown", async () => {
		const goal = new NavigateToSystem("alpha");
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state: makeState({ location: undefined }),
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(false);
		expect(result.message).toContain("unknown");
	});

	test("fails when no route found", async () => {
		const goal = new NavigateToSystem("unreachable");
		const endpoints = createMockEndpoints({
			findRoute: async () =>
				mockApiResponse({
					found: false,
					total_jumps: 0,
					target_system: "unreachable",
					message: "No path exists",
					route: [],
				}),
		});

		// Use non-docked state so this test focuses on route-not-found behaviour
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol-station",
				poi_name: "Sol Station",
				// no docked_at — ship is undocked
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("No route found");
		expect(result.ticksUsed).toBe(0);
	});

	test("jumps through multi-hop route", async () => {
		const jumpCalls: string[] = [];
		const goal = new NavigateToSystem("gamma");
		const endpoints = createMockEndpoints({
			findRoute: async () =>
				mockApiResponse({
					found: true,
					total_jumps: 3,
					target_system: "gamma",
					message: "Route found",
					route: [
						{ system_id: "sol" },
						{ system_id: "alpha" },
						{ system_id: "beta" },
						{ system_id: "gamma" },
					],
				}),
			jump: async (systemId: unknown) => {
				jumpCalls.push(systemId as string);
				return mockApiResponse({});
			},
		});

		// Use non-docked state so this test focuses on jump routing behaviour
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol-station",
				poi_name: "Sol Station",
				// no docked_at — ship is undocked
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(3);
		// Should skip current system (sol) and jump alpha → beta → gamma
		expect(jumpCalls).toEqual(["alpha", "beta", "gamma"]);
	});

	test("single hop jump", async () => {
		const jumpCalls: string[] = [];
		const goal = new NavigateToSystem("alpha");
		const endpoints = createMockEndpoints({
			findRoute: async () =>
				mockApiResponse({
					found: true,
					total_jumps: 1,
					target_system: "alpha",
					message: "Route found",
					route: [{ system_id: "sol" }, { system_id: "alpha" }],
				}),
			jump: async (systemId: unknown) => {
				jumpCalls.push(systemId as string);
				return mockApiResponse({});
			},
		});

		// Use non-docked state so this test focuses on jump routing behaviour
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol-station",
				poi_name: "Sol Station",
				// no docked_at — ship is undocked
			},
		});
		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(jumpCalls).toEqual(["alpha"]);
	});
});

// ─── GoToPoi ───────────────────────────────────────────────────────

describe("GoToPoi", () => {
	test("already satisfied when at target POI", async () => {
		const goal = new GoToPoi("sol-station");
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state: makeState(),
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("fails when location unknown and no refreshState", async () => {
		const goal = new GoToPoi("some-poi");
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state: makeState({ location: undefined }),
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(false);
		expect(result.message).toContain("unknown");
	});

	test("refreshes state when location unknown and recovers", async () => {
		let travelTarget: string | undefined;
		const goal = new GoToPoi("asteroid-belt-1");
		const endpoints = createMockEndpoints({
			travel: async (poiId: unknown) => {
				travelTarget = poiId as string;
				return mockApiResponse({
					action: "arrived",
					poi: "Asteroid Belt 1",
					poi_id: "asteroid-belt-1",
				});
			},
		});

		const freshState = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol-orbit",
				poi_name: "Sol Orbit",
				poi_type: "orbit",
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: makeState({ location: undefined }),
			refreshState: async () => freshState,
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(travelTarget).toBe("asteroid-belt-1");
	});

	test("returns alreadySatisfied when refresh shows already at target", async () => {
		const goal = new GoToPoi("asteroid-belt-1");
		const freshState = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "asteroid-belt-1",
				poi_name: "Asteroid Belt 1",
				poi_type: "asteroid_belt",
			},
		});

		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state: makeState({ location: undefined }),
			refreshState: async () => freshState,
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("travels to target POI", async () => {
		let travelTarget: string | undefined;
		const goal = new GoToPoi("asteroid-belt-1");
		const endpoints = createMockEndpoints({
			travel: async (poiId: unknown) => {
				travelTarget = poiId as string;
				return mockApiResponse({
					action: "arrived",
					poi: "Asteroid Belt 1",
					poi_id: "asteroid-belt-1",
				});
			},
		});

		const ctx: GoalContext = { endpoints, state: makeState() };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(travelTarget).toBe("asteroid-belt-1");
	});

	test("retry: returns failed when both travel attempts fail — never throws", async () => {
		// This is the critical case: ship has insufficient fuel for travel.
		// First attempt fails (caught), refresh is called, second attempt also fails.
		// GoToPoi must return failed() rather than throwing — a thrown exception
		// would escape call chains that have no try/catch (e.g. checkHarvesterForPoi)
		// and reject the loop promise instead of triggering the normal retry cycle.
		let travelCalls = 0;
		let refreshCalls = 0;
		const goal = new GoToPoi("sell-station");
		const freshState = makeState();
		const endpoints = createMockEndpoints({
			travel: async () => {
				travelCalls++;
				throw new ApiError("insufficient_fuel", "Insufficient fuel for travel", 400);
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: makeState(),
			refreshState: async () => {
				refreshCalls++;
				return freshState;
			},
		};

		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("Insufficient fuel for travel");
		expect(travelCalls).toBe(2);
		expect(refreshCalls).toBe(1);
	});

	test("retry: returns alreadySatisfied when refresh shows already at target after first failure", async () => {
		const goal = new GoToPoi("sell-station");
		const atTarget = makeState({
			location: { system_id: "sol", system_name: "Sol", poi_id: "sell-station", poi_name: "Sell" },
		});
		const endpoints = createMockEndpoints({
			travel: async () => {
				throw new ApiError("some_error", "Travel failed", 400);
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: makeState(),
			refreshState: async () => atTarget,
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});
});

// ─── DockAt ────────────────────────────────────────────────────────

describe("DockAt", () => {
	test("already satisfied when docked at target", async () => {
		const goal = new DockAt("sol-station");
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state: makeState(),
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
		expect(result.ticksUsed).toBe(0);
	});

	test("fails when not at a POI", async () => {
		const goal = new DockAt("sol-station");
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
			},
		});
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state,
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(false);
		expect(result.message).toContain("not at a POI");
	});

	test("docks at target base", async () => {
		let dockTarget: string | undefined;
		const goal = new DockAt("sol-station");
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol-station",
				poi_name: "Sol Station",
				poi_type: "station",
				// Not docked
			},
		});
		const endpoints = createMockEndpoints({
			dock: async (baseId: unknown) => {
				dockTarget = baseId as string;
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(dockTarget).toBe("sol-station");
	});

	test("docks at different base than current", async () => {
		const goal = new DockAt("other-station");
		const endpoints = createMockEndpoints({
			dock: async () => mockApiResponse({}),
		});

		const ctx: GoalContext = {
			endpoints,
			state: makeState({
				location: {
					system_id: "sol",
					system_name: "Sol",
					poi_id: "other-station",
					poi_name: "Other Station",
					poi_type: "station",
					docked_at: "sol-station",
				},
			}),
		};
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
	});

	test("treats already_docked API error as already satisfied (stale state)", async () => {
		const goal = new DockAt("sol-station");
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol-station",
				poi_name: "Sol Station",
				poi_type: "station",
				// state shows undocked, but game has us docked already
			},
		});
		const endpoints = createMockEndpoints({
			dock: async () => {
				throw new ApiError("already_docked", "Already docked", 400);
			},
		});

		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("docks for real when stale state claims docked but live state shows undocked", async () => {
		// The server can undock a ship without a mutation response through us
		// (e.g. a mobile base jumping away), leaving docked_at stale. DockAt
		// must verify against live state rather than skip the dock.
		const goal = new DockAt("sol-station");
		const staleState = makeState(); // docked_at: "sol-station" per makeState default
		const freshState = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol-station",
				poi_name: "Sol Station",
				poi_type: "station",
				// Live state: undocked
			},
		});
		let dockCalls = 0;
		const endpoints = createMockEndpoints({
			dock: async () => {
				dockCalls++;
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: staleState,
			refreshState: async () => freshState,
		};
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBeFalsy();
		expect(result.ticksUsed).toBe(1);
		expect(dockCalls).toBe(1);
	});
});

// ─── EnsureUndocked ────────────────────────────────────────────────

describe("EnsureUndocked", () => {
	test("already satisfied when not docked", async () => {
		const goal = new EnsureUndocked();
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol-station",
				poi_name: "Sol Station",
				poi_type: "station",
				// No docked_at
			},
		});
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state,
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("already satisfied when docked_at is null", async () => {
		const goal = new EnsureUndocked();
		const state = makeState({
			location: {
				system_id: "sol",
				system_name: "Sol",
			},
		});
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state,
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("undocks when currently docked", async () => {
		let undockCalled = false;
		const goal = new EnsureUndocked();
		const endpoints = createMockEndpoints({
			undock: async () => {
				undockCalled = true;
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = { endpoints, state: makeState() };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(undockCalled).toBe(true);
	});
});

// ─── EnsureFueled ──────────────────────────────────────────────────

describe("EnsureFueled", () => {
	test("already satisfied when fuel is at max", async () => {
		const goal = new EnsureFueled();
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state: makeState(),
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("already satisfied when fuel meets target", async () => {
		const goal = new EnsureFueled(30);
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state: makeState(),
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("fails when ship state unknown", async () => {
		const goal = new EnsureFueled();
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state: makeState({ ship: undefined }),
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(false);
		expect(result.message).toContain("unknown");
	});

	test("fails when not docked", async () => {
		const goal = new EnsureFueled();
		const state = makeState({
			ship: { id: "s1", class_id: "scout", fuel: 10, max_fuel: 50 },
			location: {
				system_id: "sol",
				system_name: "Sol",
				// Not docked
			},
		});
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state,
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("refuels to max when no target specified", async () => {
		let refuelAmount: number | undefined;
		const goal = new EnsureFueled();
		const state = makeState({
			ship: { id: "s1", class_id: "scout", fuel: 20, max_fuel: 50 },
		});
		const endpoints = createMockEndpoints({
			refuel: async (quantity: unknown) => {
				refuelAmount = quantity as number;
				return mockApiResponse({
					action: "refuel",
					fuel: 30,
					fuel_now: 50,
					fuel_max: 50,
					cost: 150,
				});
			},
		});

		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(refuelAmount).toBe(30);
	});

	test("refuels to specific target", async () => {
		let refuelAmount: number | undefined;
		const goal = new EnsureFueled(35);
		const state = makeState({
			ship: { id: "s1", class_id: "scout", fuel: 20, max_fuel: 50 },
		});
		const endpoints = createMockEndpoints({
			refuel: async (quantity: unknown) => {
				refuelAmount = quantity as number;
				return mockApiResponse({
					action: "refuel",
					fuel: 15,
					fuel_now: 35,
					fuel_max: 50,
					cost: 75,
				});
			},
		});

		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(refuelAmount).toBe(15);
	});

	test("treats tank_full API error as already satisfied (stale state)", async () => {
		const goal = new EnsureFueled();
		const state = makeState({
			ship: { id: "s1", class_id: "scout", fuel: 49, max_fuel: 50 }, // state shows 1 unit short
		});
		const endpoints = createMockEndpoints({
			refuel: async () => {
				throw new ApiError("tank_full", "Tank is already full", 400);
			},
		});

		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("soft-fails on insufficient credits — succeeds with 0 ticks and warns", async () => {
		const goal = new EnsureFueled();
		const state = makeState({
			ship: { id: "s1", class_id: "scout", fuel: 30, max_fuel: 100 },
		});
		const endpoints = createMockEndpoints({
			refuel: async () => {
				throw new ApiError("insufficient_credits", "Not enough credits to refuel", 400);
			},
		});

		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		// Soft success — loop continues, NavigateToSystem pre-flight blocks if fuel is truly insufficient
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("Refuel skipped");
		expect(result.message).toContain("30/100");
	});

	test("soft-fails on any unknown game error from refuel", async () => {
		const goal = new EnsureFueled();
		const state = makeState({
			ship: { id: "s1", class_id: "scout", fuel: 50, max_fuel: 100 },
		});
		const endpoints = createMockEndpoints({
			refuel: async () => {
				throw new ApiError("pump_unavailable", "Fuel pump is offline", 400);
			},
		});

		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(0);
		expect(result.message).toContain("pump_unavailable");
	});

	test("hard-fails on invalid_params — propagates as thrown error", async () => {
		const goal = new EnsureFueled();
		const state = makeState({
			ship: { id: "s1", class_id: "scout", fuel: 20, max_fuel: 50 },
		});
		const endpoints = createMockEndpoints({
			refuel: async () => {
				throw new ApiError("invalid_params", "Invalid quantity parameter", 400);
			},
		});

		const ctx: GoalContext = { endpoints, state };
		await expect(goal.execute(ctx)).rejects.toThrow("Invalid quantity parameter");
	});

	test("hard-fails on unknown_command — propagates as thrown error", async () => {
		const goal = new EnsureFueled();
		const state = makeState({
			ship: { id: "s1", class_id: "scout", fuel: 20, max_fuel: 50 },
		});
		const endpoints = createMockEndpoints({
			refuel: async () => {
				throw new ApiError("unknown_command", "Unknown command: refuel", 400);
			},
		});

		const ctx: GoalContext = { endpoints, state };
		await expect(goal.execute(ctx)).rejects.toThrow("Unknown command: refuel");
	});

	test("station limited supply — retries until tank is full", async () => {
		// First attempt: station only has 15 fuel. Second attempt: full.
		let refuelCalls = 0;
		const goal = new EnsureFueled(undefined, 0); // 0ms retry delay for testing
		const state = makeState({
			ship: { id: "s1", class_id: "scout", fuel: 10, max_fuel: 50 },
		});
		const endpoints = createMockEndpoints({
			refuel: async (_quantity: unknown) => {
				refuelCalls++;
				if (refuelCalls === 1) {
					// Station ran out — only provided 15 units
					return mockApiResponse({
						action: "refuel",
						fuel: 15,
						fuel_now: 25, // got to 25, not the target 50
						fuel_max: 50,
					});
				}
				// Station restocked — fill remainder
				return mockApiResponse({
					action: "refuel",
					fuel: 25,
					fuel_now: 50,
					fuel_max: 50,
				});
			},
		});

		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(2); // two refuel ticks
		expect(result.message).toContain("50/50");
		expect(refuelCalls).toBe(2);
	});

	test("station limited supply — abort signal stops retrying with partial fill", async () => {
		// Station only partially fills; abort signal fires during the wait.
		const controller = new AbortController();
		let refuelCalls = 0;
		const goal = new EnsureFueled(undefined, 0); // 0ms delay for testing
		const state = makeState({
			ship: { id: "s1", class_id: "scout", fuel: 10, max_fuel: 50 },
		});
		const endpoints = createMockEndpoints({
			refuel: async () => {
				refuelCalls++;
				// Always partial — station never fully restocks
				return mockApiResponse({
					action: "refuel",
					fuel: 5,
					fuel_now: 15,
					fuel_max: 50,
				});
			},
		});

		// Abort after the first refuel completes but during the retry wait
		const ctx: GoalContext = {
			endpoints,
			state,
			signal: controller.signal,
		};

		// Trigger abort asynchronously so it fires during the wait
		setImmediate(() => controller.abort());

		const result = await goal.execute(ctx);

		// Partial fill — returns what it got
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.message).toContain("15/50");
		expect(refuelCalls).toBe(1);
	});

	test("station limited supply — uses fuel_now absent fallback (assumes success)", async () => {
		// When fuel_now is absent from response, assume the full amount was delivered.
		const goal = new EnsureFueled(undefined, 0);
		const state = makeState({
			ship: { id: "s1", class_id: "scout", fuel: 20, max_fuel: 50 },
		});
		let refuelCalls = 0;
		const endpoints = createMockEndpoints({
			refuel: async () => {
				refuelCalls++;
				return mockApiResponse({
					action: "refuel",
					fuel: 30,
					// fuel_now intentionally absent
				});
			},
		});

		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		// Without fuel_now, we assume success — no retry
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(refuelCalls).toBe(1);
	});
});

// ─── EnsureRepaired ────────────────────────────────────────────────

describe("EnsureRepaired", () => {
	test("already satisfied when hull is at max", async () => {
		const goal = new EnsureRepaired();
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state: makeState(),
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("fails when ship state unknown", async () => {
		const goal = new EnsureRepaired();
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state: makeState({ ship: undefined }),
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(false);
		expect(result.message).toContain("unknown");
	});

	test("fails when not docked", async () => {
		const goal = new EnsureRepaired();
		const state = makeState({
			ship: { id: "s1", class_id: "scout", hull: 50, max_hull: 100 },
			location: {
				system_id: "sol",
				system_name: "Sol",
			},
		});
		const ctx: GoalContext = {
			endpoints: createMockEndpoints(),
			state,
		};

		const result = await goal.execute(ctx);
		expect(result.success).toBe(false);
		expect(result.message).toContain("must be docked");
	});

	test("repairs when hull is damaged", async () => {
		let repairCalled = false;
		const goal = new EnsureRepaired();
		const state = makeState({
			ship: { id: "s1", class_id: "scout", hull: 60, max_hull: 100 },
		});
		const endpoints = createMockEndpoints({
			repair: async () => {
				repairCalled = true;
				return mockApiResponse({ action: "repair", repaired: 40, cost: 200 });
			},
		});

		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBe(1);
		expect(repairCalled).toBe(true);
		expect(result.message).toContain("40");
	});

	test("treats hull_full API error as already satisfied (stale state)", async () => {
		const goal = new EnsureRepaired();
		const state = makeState({
			ship: { id: "s1", class_id: "scout", hull: 99, max_hull: 100 }, // state shows damage
		});
		const endpoints = createMockEndpoints({
			repair: async () => {
				throw new ApiError("hull_full", "Hull is already full", 400);
			},
		});

		const ctx: GoalContext = { endpoints, state };
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});
});
