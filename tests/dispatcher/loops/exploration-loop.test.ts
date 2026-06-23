import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { runExplorationLoop } from "../../../src/dispatcher/loops/exploration-loop.js";
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
		player: { id: "p1", username: "Test", credits: 1000 },
		ship: { ...defaultShip },
		cargo: [],
		location: {
			system_id: "home",
			system_name: "Home System",
			poi_id: "home_station",
			poi_name: "Home Station",
			docked_at: "home_base",
		},
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

/**
 * Static navigation map: home + A + B.
 * All systems are always present (the map is a static file, same for all players).
 * empireA/empireB control the empire of each system.
 */
function makeMap(options: { empireA?: string; empireB?: string } = {}) {
	return [
		{
			system_id: "home",
			name: "Home System",
			visited: true,
			connections: ["A", "B"],
			empire: "solarian",
		},
		{
			system_id: "A",
			name: "System A",
			visited: false,
			connections: ["home"],
			empire: options.empireA ?? "solarian",
		},
		{
			system_id: "B",
			name: "System B",
			visited: false,
			connections: ["home"],
			empire: options.empireB ?? "solarian",
		},
	];
}

/** Build a queryIntel response with the given system_ids already recorded. */
function makeIntelEntries(recordedIds: string[], submittedAtTick = 9999) {
	return {
		count: recordedIds.length,
		total: recordedIds.length,
		intel_level: 2,
		message: `Found ${recordedIds.length} system(s)`,
		entries: recordedIds.map((id) => ({ system_id: id, submitted_at_tick: submittedAtTick })),
	};
}

const undockMock = (currentState: { value: ReturnType<typeof makeState> }) => async () => {
	const loc = currentState.value.location;
	currentState.value = makeState({
		...currentState.value,
		location: {
			system_id: loc?.system_id ?? "home",
			system_name: loc?.system_name ?? "Home System",
			...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
			...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
		},
	});
	return mockApiResponse({});
};

describe("runExplorationLoop", () => {
	test("fails immediately if intel_level < 2", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			intelStatus: async () => mockApiResponse({ intel_level: 1 }),
		});

		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const result = await runExplorationLoop(
			{ systemId: "home", stationPoiId: "home_station", baseId: "home_base" },
			ctx,
		);

		expect(result.success).toBe(false);
		expect(result.iterationCount).toBe(0);
		expect(result.message).toContain("Level 2 Intel Center");
	});

	test("fails if intel_status throws", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			intelStatus: async () => {
				throw new Error("No intel facility");
			},
		});

		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const result = await runExplorationLoop(
			{ systemId: "home", stationPoiId: "home_station", baseId: "home_base" },
			ctx,
		);

		expect(result.success).toBe(false);
		expect(result.iterationCount).toBe(0);
		expect(result.message).toContain("Failed to check intel status");
	});

	test("fails if home system not found in map", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			intelStatus: async () => mockApiResponse({ intel_level: 2 }),
			getMap: async () =>
				mockApiResponse({
					systems: [
						{
							system_id: "other",
							name: "Other",
							visited: false,
							connections: [],
							empire: "solarian",
						},
					],
					total_count: 1,
				}),
		});

		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const result = await runExplorationLoop(
			{ systemId: "home", stationPoiId: "home_station", baseId: "home_base" },
			ctx,
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("not found in map");
	});

	test("fails when get_map returns the single-system variant instead of a systems list", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			intelStatus: async () => mockApiResponse({ intel_level: 2 }),
			getMap: async () =>
				mockApiResponse({
					system_id: "home",
					name: "Home",
					visited: true,
					connections: [],
				}),
		});

		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const result = await runExplorationLoop(
			{ systemId: "home", stationPoiId: "home_station", baseId: "home_base" },
			ctx,
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain("did not return a systems list");
	});

	test("terminates when all qualifying systems are already recorded in intel", async () => {
		const state = makeState();
		const systems = makeMap();

		const endpoints = createMockEndpoints({
			intelStatus: async () => mockApiResponse({ intel_level: 2 }),
			getMap: async () => mockApiResponse({ systems, total_count: systems.length }),
			// A and B are already in the intel database
			queryIntel: async () => mockApiResponse(makeIntelEntries(["A", "B"])),
		});

		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const result = await runExplorationLoop(
			{
				systemId: "home",
				stationPoiId: "home_station",
				baseId: "home_base",
				loopOptions: { maxIterations: 5 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1); // One iteration ran, returned alreadySatisfied
	});

	test("navigates to nearest unrecorded system", async () => {
		const currentState = { value: makeState() };
		let navigationTarget: string | undefined;

		// A is 1 hop away and unrecorded; B is also 1 hop but already recorded
		const systems = makeMap();

		const endpoints = createMockEndpoints({
			intelStatus: async () => mockApiResponse({ intel_level: 2 }),
			getMap: async () => mockApiResponse({ systems, total_count: systems.length }),
			getState: async () => mockApiResponse({}),
			queryIntel: async () => mockApiResponse(makeIntelEntries(["B"])), // B recorded, A not
			findRoute: async (targetId) => {
				navigationTarget = targetId as string;
				return mockApiResponse({
					found: true,
					fuel_per_jump: 2,
					estimated_fuel: 2,
					route: [{ system_id: targetId }],
					total_jumps: 1,
					message: "Route found",
				});
			},
			undock: undockMock(currentState),
			jump: async (targetId) => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: targetId as string, system_name: String(targetId) },
				});
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runExplorationLoop(
			{
				systemId: "home",
				stationPoiId: "home_station",
				baseId: "home_base",
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(navigationTarget).toBe("A"); // Only A is unrecorded
	});

	test("empire filter — skips lawless systems when allowLawless is false", async () => {
		const state = makeState();
		// A is lawless (no empire), B is already recorded — nothing to explore in home empire
		const systems = makeMap({ empireA: "" });

		const endpoints = createMockEndpoints({
			intelStatus: async () => mockApiResponse({ intel_level: 2 }),
			getMap: async () => mockApiResponse({ systems, total_count: systems.length }),
			queryIntel: async () => mockApiResponse(makeIntelEntries(["B"])), // B recorded
		});

		const ctx: GoalContext = { endpoints, state, refreshState: async () => state };

		const result = await runExplorationLoop(
			{
				systemId: "home",
				stationPoiId: "home_station",
				baseId: "home_base",
				allowLawless: false,
				loopOptions: { maxIterations: 5 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		// A is lawless and filtered out, B is recorded — terminates after 1 iteration
		expect(result.iterationCount).toBe(1);
	});

	test("empire filter — includes lawless systems when allowLawless is true", async () => {
		const currentState = { value: makeState() };
		let navigationTarget: string | undefined;

		// A is lawless (no empire), B is already recorded
		const systems = makeMap({ empireA: "" });

		const endpoints = createMockEndpoints({
			intelStatus: async () => mockApiResponse({ intel_level: 2 }),
			getMap: async () => mockApiResponse({ systems, total_count: systems.length }),
			getState: async () => mockApiResponse({}),
			queryIntel: async () => mockApiResponse(makeIntelEntries(["B"])), // B recorded, A not
			findRoute: async (targetId) => {
				navigationTarget = targetId as string;
				return mockApiResponse({
					found: true,
					fuel_per_jump: 2,
					estimated_fuel: 2,
					route: [{ system_id: targetId }],
					total_jumps: 1,
					message: "Route found",
				});
			},
			undock: undockMock(currentState),
			jump: async (targetId) => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: targetId as string, system_name: String(targetId) },
				});
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runExplorationLoop(
			{
				systemId: "home",
				stationPoiId: "home_station",
				baseId: "home_base",
				allowLawless: true,
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(navigationTarget).toBe("A"); // Lawless A is explored when allowLawless=true
	});

	test("returns home to refuel when fuel insufficient for round trip", async () => {
		const currentState = {
			value: makeState({
				ship: { ...defaultShip, fuel: 4, max_fuel: 50 },
			}),
		};
		const prepareAtStationCalled: string[] = [];
		let navigationTarget: string | undefined;

		const systems = makeMap();

		const endpoints = createMockEndpoints({
			intelStatus: async () => mockApiResponse({ intel_level: 2 }),
			getMap: async () => mockApiResponse({ systems, total_count: systems.length }),
			getState: async () => mockApiResponse({}),
			// B is recorded, A is the target (1 hop away)
			queryIntel: async () => mockApiResponse(makeIntelEntries(["B"])),
			findRoute: async (targetId) => {
				navigationTarget = targetId as string;
				return mockApiResponse({
					found: true,
					fuel_per_jump: 2,
					estimated_fuel: 2,
					route: [{ system_id: targetId }],
					total_jumps: 1,
					message: "Route found",
				});
			},
			undock: undockMock(currentState),
			jump: async (targetId) => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: targetId as string, system_name: String(targetId) },
				});
				return mockApiResponse({});
			},
			travel: async (poiId) => {
				prepareAtStationCalled.push(`travel:${String(poiId)}`);
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "home",
						system_name: "Home System",
						poi_id: poiId as string,
						poi_name: String(poiId),
					},
				});
				return mockApiResponse({});
			},
			dock: async (baseId) => {
				prepareAtStationCalled.push(`dock:${String(baseId)}`);
				currentState.value = makeState({
					...currentState.value,
					location: {
						...currentState.value.location,
						docked_at: baseId as string,
					},
				});
				return mockApiResponse({});
			},
			refuel: async () => {
				prepareAtStationCalled.push("refuel");
				currentState.value = makeState({
					...currentState.value,
					ship: { ...defaultShip, fuel: 50 },
				});
				return mockApiResponse({});
			},
			repair: async () => {
				prepareAtStationCalled.push("repair");
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		// A is 1 hop away, return is 1 hop: round trip = 4 fuel, + reserve(10) = 14 needed
		// Ship has fuel=4 which is < 14, so PrepareAtStation should be called first
		const result = await runExplorationLoop(
			{
				systemId: "home",
				stationPoiId: "home_station",
				baseId: "home_base",
				minFuelReserve: 10,
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(prepareAtStationCalled).toContain("refuel");
		expect(navigationTarget).toBe("A");
	});

	test("calls survey_system after navigation when survey=true", async () => {
		const currentState = { value: makeState() };
		let surveyCallCount = 0;

		const systems = makeMap();

		const endpoints = createMockEndpoints({
			intelStatus: async () => mockApiResponse({ intel_level: 2 }),
			getMap: async () => mockApiResponse({ systems, total_count: systems.length }),
			getState: async () => mockApiResponse({}),
			queryIntel: async () => mockApiResponse(makeIntelEntries(["B"])), // B recorded, A not
			findRoute: async (targetId) =>
				mockApiResponse({
					found: true,
					fuel_per_jump: 2,
					estimated_fuel: 2,
					route: [{ system_id: targetId }],
					total_jumps: 1,
					message: "Route found",
				}),
			undock: undockMock(currentState),
			jump: async (targetId) => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: targetId as string, system_name: String(targetId) },
				});
				return mockApiResponse({});
			},
			surveySystem: async () => {
				surveyCallCount++;
				return mockApiResponse({
					message: "Survey complete",
					already_revealed: [],
					newly_revealed: [],
					faint_signatures: [],
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runExplorationLoop(
			{
				systemId: "home",
				stationPoiId: "home_station",
				baseId: "home_base",
				survey: true,
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(surveyCallCount).toBe(1);
	});

	test("does not call survey_system when survey=false", async () => {
		const currentState = { value: makeState() };
		let surveyCallCount = 0;

		const systems = makeMap();

		const endpoints = createMockEndpoints({
			intelStatus: async () => mockApiResponse({ intel_level: 2 }),
			getMap: async () => mockApiResponse({ systems, total_count: systems.length }),
			getState: async () => mockApiResponse({}),
			queryIntel: async () => mockApiResponse(makeIntelEntries(["B"])),
			findRoute: async (targetId) =>
				mockApiResponse({
					found: true,
					fuel_per_jump: 2,
					estimated_fuel: 2,
					route: [{ system_id: targetId }],
					total_jumps: 1,
					message: "Route found",
				}),
			undock: undockMock(currentState),
			jump: async (targetId) => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: targetId as string, system_name: String(targetId) },
				});
				return mockApiResponse({});
			},
			surveySystem: async () => {
				surveyCallCount++;
				return mockApiResponse({
					message: "Survey complete",
					already_revealed: [],
					newly_revealed: [],
					faint_signatures: [],
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		await runExplorationLoop(
			{
				systemId: "home",
				stationPoiId: "home_station",
				baseId: "home_base",
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(surveyCallCount).toBe(0);
	});

	test("minSubmittedAtTick — re-explores systems with stale intel", async () => {
		const currentState = { value: makeState() };
		let navigationTarget: string | undefined;

		const systems = makeMap();

		const endpoints = createMockEndpoints({
			intelStatus: async () => mockApiResponse({ intel_level: 2 }),
			getMap: async () => mockApiResponse({ systems, total_count: systems.length }),
			getState: async () => mockApiResponse({}),
			// A has tick 100 (stale), B has tick 9999 (fresh)
			queryIntel: async () =>
				mockApiResponse({
					count: 2,
					total: 2,
					intel_level: 2,
					message: "Found 2 system(s)",
					entries: [
						{ system_id: "A", submitted_at_tick: 100 },
						{ system_id: "B", submitted_at_tick: 9999 },
					],
				}),
			findRoute: async (targetId) => {
				navigationTarget = targetId as string;
				return mockApiResponse({
					found: true,
					fuel_per_jump: 2,
					estimated_fuel: 2,
					route: [{ system_id: targetId }],
					total_jumps: 1,
					message: "Route found",
				});
			},
			undock: undockMock(currentState),
			jump: async (targetId) => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: targetId as string, system_name: String(targetId) },
				});
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		// minSubmittedAtTick=500 means entries with tick < 500 are treated as unvisited
		// A (tick=100) is stale → should be re-explored; B (tick=9999) is fresh → skip
		const result = await runExplorationLoop(
			{
				systemId: "home",
				stationPoiId: "home_station",
				baseId: "home_base",
				minSubmittedAtTick: 500,
				loopOptions: { maxIterations: 1 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBe(1);
		expect(navigationTarget).toBe("A");
	});

	test("cancels via AbortSignal", async () => {
		const controller = new AbortController();
		const currentState = { value: makeState() };
		let iterationCount = 0;

		const systems = makeMap();

		const endpoints = createMockEndpoints({
			intelStatus: async () => mockApiResponse({ intel_level: 2 }),
			getMap: async () => mockApiResponse({ systems, total_count: systems.length }),
			getState: async () => mockApiResponse({}),
			queryIntel: async () => mockApiResponse(makeIntelEntries([])), // Nothing recorded yet
			findRoute: async (targetId) =>
				mockApiResponse({
					found: true,
					fuel_per_jump: 2,
					estimated_fuel: 2,
					route: [{ system_id: targetId }],
					total_jumps: 1,
					message: "Route found",
				}),
			undock: undockMock(currentState),
			jump: async (targetId) => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: targetId as string, system_name: String(targetId) },
				});
				iterationCount++;
				if (iterationCount >= 1) {
					controller.abort();
				}
				return mockApiResponse({});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		const result = await runExplorationLoop(
			{
				systemId: "home",
				stationPoiId: "home_station",
				baseId: "home_base",
				loopOptions: { signal: controller.signal, maxIterations: 10 },
			},
			ctx,
		);

		expect(result.success).toBe(true);
		expect(result.iterationCount).toBeLessThan(10);
	});
});
