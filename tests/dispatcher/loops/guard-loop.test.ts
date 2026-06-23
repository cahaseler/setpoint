import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { runGuardLoop } from "../../../src/dispatcher/loops/guard-loop.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

const defaultShip = {
	id: "s1",
	hull: 100,
	max_hull: 100,
	fuel: 50,
	max_fuel: 50,
	cargo_capacity: 100,
	cargo_used: 0,
};

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 5000 },
		ship: { ...defaultShip },
		cargo: [],
		location: {
			system_id: "sol",
			system_name: "Sol",
			poi_id: "sol_station",
			poi_name: "Sol Station",
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

function makePirate(id: string) {
	return {
		pirate_id: id,
		name: `Pirate ${id}`,
		tier: "tier_1",
		is_boss: false,
		status: "active",
		hull: 50,
		max_hull: 50,
		shield: 0,
		max_shield: 0,
	};
}

const defaultOptions = {
	homeSystemId: "sol",
	homeStationPoiId: "sol_station",
	homeBaseId: "sol_base",
	guardSystemId: "sol",
	guardPoiId: "belt_1",
};

/**
 * Build mocks for a full guard sweep cycle where the guard POI is in the same
 * system as home. The ship starts docked at home.
 *
 * Sequence: getState → undock → (NavigateToSystem alreadySatisfied) →
 *   travel(guardPoiId) → [getNearby/attack/getNearby logic via extraMocks]
 *   → next iteration: getState → undock...
 */
function buildCycleMocks(
	extraMocks: Partial<Record<string, (...args: unknown[]) => Promise<unknown>>> = {},
) {
	const currentState = { value: makeState() };
	return {
		currentState,
		endpoints: createMockEndpoints({
			getState: async () => mockApiResponse({}),
			undock: async () => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: "sol_station",
						poi_name: "Sol Station",
					},
				});
				return mockApiResponse({});
			},
			travel: async (poiId) => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "sol",
						system_name: "Sol",
						poi_id: poiId as string,
						poi_name: String(poiId),
					},
				});
				return mockApiResponse({});
			},
			dock: async (baseId) => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						...currentState.value.location,
						docked_at: baseId as string,
					},
				});
				return mockApiResponse({});
			},
			refuel: async () => mockApiResponse({}),
			repair: async () => mockApiResponse({}),
			...extraMocks,
		}),
	};
}

describe("runGuardLoop", () => {
	test("area already clear — continues without attacking", async () => {
		let attackCalled = false;
		const { currentState, endpoints } = buildCycleMocks({
			getNearby: async () =>
				mockApiResponse({ pirates: [], nearby: [], count: 0, pirate_count: 0, poi_id: "belt_1" }),
			attack: async () => {
				attackCalled = true;
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runGuardLoop(
			{ ...defaultOptions, loopOptions: { maxIterations: 1 } },
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(attackCalled).toBe(false);
	});

	test("attacks pirate and clears area", async () => {
		const pirate = makePirate("p1");
		let attackCalled = false;
		let nearbyCallCount = 0;
		const { currentState, endpoints } = buildCycleMocks({
			getNearby: async () => {
				nearbyCallCount++;
				// First call: pirate present. Second call (after attack): area clear.
				const pirates = nearbyCallCount === 1 ? [pirate] : [];
				return mockApiResponse({
					pirates,
					nearby: [],
					count: pirates.length,
					pirate_count: pirates.length,
					poi_id: "belt_1",
				});
			},
			attack: async () => {
				attackCalled = true;
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runGuardLoop(
			{ ...defaultOptions, loopOptions: { maxIterations: 1 } },
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(attackCalled).toBe(true);
	});

	test("attacks multiple pirates sequentially", async () => {
		const pirate1 = makePirate("p1");
		const pirate2 = makePirate("p2");
		const attackedIds: string[] = [];
		let nearbyCallCount = 0;
		const { currentState, endpoints } = buildCycleMocks({
			getNearby: async () => {
				nearbyCallCount++;
				// Call 1: both pirates present → attack p1
				// Call 2: p1 gone, p2 still there → attack p2
				// Call 3: area clear
				let pirates: (typeof pirate1)[];
				if (nearbyCallCount === 1) {
					pirates = [pirate1, pirate2];
				} else if (nearbyCallCount === 2) {
					pirates = [pirate2];
				} else {
					pirates = [];
				}
				return mockApiResponse({
					pirates,
					nearby: [],
					count: pirates.length,
					pirate_count: pirates.length,
					poi_id: "belt_1",
				});
			},
			attack: async (id) => {
				attackedIds.push(id as string);
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runGuardLoop(
			{ ...defaultOptions, loopOptions: { maxIterations: 1 } },
			ctx,
		);

		expect(result.success).toBe(true);
		expect(attackedIds).toEqual(["p1", "p2"]);
	});

	test("fails when hull drops to 0 during combat polling", async () => {
		const pirate = makePirate("p1");
		let attackDone = false;
		const currentState = { value: makeState() };
		const endpoints = createMockEndpoints({
			getState: async () => mockApiResponse({}),
			undock: async () => mockApiResponse({}),
			travel: async () => mockApiResponse({}),
			dock: async () => mockApiResponse({}),
			refuel: async () => mockApiResponse({}),
			repair: async () => mockApiResponse({}),
			getNearby: async () =>
				mockApiResponse({
					pirates: [pirate],
					nearby: [],
					count: 1,
					pirate_count: 1,
					poi_id: "belt_1",
				}),
			attack: async () => {
				attackDone = true;
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => {
				// Return hull=0 after attack has been called
				if (attackDone) {
					return makeState({ ship: { ...defaultShip, hull: 0 } });
				}
				return currentState.value;
			},
		};

		const result = await runGuardLoop(
			{
				...defaultOptions,
				loopOptions: { maxIterations: 1, maxConsecutiveFailures: 1, retryDelayMs: 0 },
			},
			ctx,
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("failure");
	});

	test("cancels via AbortSignal", async () => {
		const controller = new AbortController();
		let iterationCount = 0;
		const { currentState, endpoints } = buildCycleMocks({
			getNearby: async () => {
				iterationCount++;
				if (iterationCount >= 2) controller.abort();
				return mockApiResponse({
					pirates: [],
					nearby: [],
					count: 0,
					pirate_count: 0,
					poi_id: "belt_1",
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runGuardLoop(
			{
				...defaultOptions,
				loopOptions: { signal: controller.signal, maxIterations: 10 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBeLessThan(10);
		expect(result.message).toContain("cancelled");
	});

	test("stays at post when hull is full — repair never called", async () => {
		let repairCalled = false;
		const { currentState, endpoints } = buildCycleMocks({
			getNearby: async () =>
				mockApiResponse({ pirates: [], nearby: [], count: 0, pirate_count: 0, poi_id: "belt_1" }),
			repair: async () => {
				repairCalled = true;
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runGuardLoop(
			{ ...defaultOptions, loopOptions: { maxIterations: 2 } },
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(2);
		expect(repairCalled).toBe(false);
	});

	test("returns home to refuel when fuel drops below fuelThreshold", async () => {
		let refuelCalled = false;
		const { currentState, endpoints } = buildCycleMocks({
			getNearby: async () =>
				mockApiResponse({ pirates: [], nearby: [], count: 0, pirate_count: 0, poi_id: "belt_1" }),
			refuel: async () => {
				refuelCalled = true;
				return mockApiResponse({});
			},
		});

		// Full hull, but low fuel — below 50% threshold
		currentState.value = makeState({
			...currentState.value,
			ship: { ...defaultShip, fuel: 20, max_fuel: 100 },
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runGuardLoop(
			{ ...defaultOptions, fuelThreshold: 50, loopOptions: { maxIterations: 1 } },
			ctx,
		);

		expect(result.success).toBe(true);
		expect(refuelCalled).toBe(true);
	});

	test("does NOT return home when fuel is above fuelThreshold", async () => {
		let refuelCalled = false;
		const { currentState, endpoints } = buildCycleMocks({
			getNearby: async () =>
				mockApiResponse({ pirates: [], nearby: [], count: 0, pirate_count: 0, poi_id: "belt_1" }),
			refuel: async () => {
				refuelCalled = true;
				return mockApiResponse({});
			},
		});

		// Fuel at 80% — above 50% threshold
		currentState.value = makeState({
			...currentState.value,
			ship: { ...defaultShip, fuel: 80, max_fuel: 100 },
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		await runGuardLoop(
			{ ...defaultOptions, fuelThreshold: 50, loopOptions: { maxIterations: 1 } },
			ctx,
		);

		// Refuel not called at home station (didn't return home)
		expect(refuelCalled).toBe(false);
	});

	test("stops attacking when the abort signal fires between attacks", async () => {
		const controller = new AbortController();
		const pirate = makePirate("p1");
		let attackCalls = 0;
		const { currentState, endpoints } = buildCycleMocks({
			// Pirate is always present, so only the signal can end combat.
			getNearby: async () =>
				mockApiResponse({
					pirates: [pirate],
					nearby: [],
					count: 1,
					pirate_count: 1,
					poi_id: "belt_1",
				}),
			attack: async () => {
				attackCalls++;
				// Force abort lands while an attack is in flight.
				controller.abort();
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runGuardLoop(
			{
				...defaultOptions,
				loopOptions: { signal: controller.signal, maxIterations: 1, retryDelayMs: 0 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.message).toContain("cancelled");
		expect(attackCalls).toBe(1);
	});

	test("returns home to repair when hull drops below threshold", async () => {
		let repairCalled = false;
		const { currentState, endpoints } = buildCycleMocks({
			getNearby: async () =>
				mockApiResponse({ pirates: [], nearby: [], count: 0, pirate_count: 0, poi_id: "belt_1" }),
			repair: async () => {
				repairCalled = true;
				return mockApiResponse({});
			},
		});

		// Start with damaged hull (below default threshold of 100%)
		currentState.value = makeState({
			...currentState.value,
			ship: { ...defaultShip, hull: 50 },
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runGuardLoop(
			{ ...defaultOptions, loopOptions: { maxIterations: 1 } },
			ctx,
		);

		expect(result.success).toBe(true);
		expect(repairCalled).toBe(true);
	});
});
