import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import { runRoamingSalvageLoop } from "../../../src/dispatcher/loops/roaming-salvage-loop.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

const defaultShip = {
	id: "s1",
	hull: 100,
	max_hull: 100,
	fuel: 200,
	max_fuel: 200,
	cargo_capacity: 100,
	cargo_used: 0,
};

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 5000 },
		ship: { ...defaultShip },
		cargo: [],
		location: {
			system_id: "home",
			system_name: "Home System",
			poi_id: "home_station_poi",
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

/** Make a minimal map with home + named systems. */
function makeMap(systems: Array<{ id: string; empire?: string; connections?: string[] }>) {
	return systems.map((s) => ({
		system_id: s.id,
		name: s.id,
		visited: false,
		empire: s.empire ?? "solarian",
		connections: s.connections ?? [],
	}));
}

/** Make a GetSystemResponse with the given POIs. */
function makeSystemResponse(systemId: string, pois: Array<{ id: string; hasBase?: boolean }>) {
	return {
		action: "get_system",
		security_status: "low",
		system: {
			id: systemId,
			name: systemId,
			police_level: 1,
			connections: [],
			pois: pois.map((p) => ({
				id: p.id,
				name: p.id,
				type: "asteroid_belt",
				has_base: p.hasBase ?? false,
				online: 0,
				position: { x: 0, y: 0 },
			})),
		},
	};
}

function makeWreck(id: string) {
	return {
		id,
		cargo: [{ item_id: "iron_ore", quantity: 5, name: "Iron Ore" }],
		modules: [],
		salvage_value: 50,
		ship_class: "fighter",
		victim_id: "p99",
		victim_name: "Victim",
		created_at: "2026-01-01T00:00:00Z",
		expires_at: "2026-01-02T00:00:00Z",
		expire_tick: 9999,
	};
}

const defaultOptions = {
	homeSystemId: "home",
	homeStationPoiId: "home_station_poi",
	homeBaseId: "home_base",
};

describe("runRoamingSalvageLoop", () => {
	test("fails immediately if home system not in map", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			getMap: async () => mockApiResponse({ systems: makeMap([{ id: "other" }]) }),
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const result = await runRoamingSalvageLoop({ ...defaultOptions, homeSystemId: "missing" }, ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("missing");
	});

	test("fails when get_map returns the single-system variant instead of a systems list", async () => {
		const state = makeState();
		const endpoints = createMockEndpoints({
			getMap: async () =>
				mockApiResponse({
					system_id: "home",
					name: "Home",
					visited: true,
					connections: [],
				}),
		});
		const ctx: GoalContext = {
			endpoints,
			state,
			refreshState: async () => state,
		};

		const result = await runRoamingSalvageLoop(defaultOptions, ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("did not return a systems list");
	});

	test("navigates to a system and visits its non-station POIs", async () => {
		const currentState = { value: makeState() };
		const systemsVisited: string[] = [];
		const poisVisited: string[] = [];

		const endpoints = createMockEndpoints({
			getState: async () => {
				return mockApiResponse({ ship: currentState.value.ship });
			},
			getMap: async () =>
				mockApiResponse({
					systems: makeMap([
						{ id: "home", connections: ["alpha"] },
						{ id: "alpha", connections: ["home"] },
					]),
				}),
			findRoute: async (targetId: unknown) => {
				systemsVisited.push(targetId as string);
				return mockApiResponse({
					found: true,
					estimated_fuel: 5,
					fuel_per_jump: 5,
					total_jumps: 1,
					route: [{ system_id: targetId }],
				});
			},
			jump: async () => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: "alpha", system_name: "Alpha" },
				});
				return mockApiResponse({ action: "jump", destination: "alpha" });
			},
			getSystem: async () =>
				mockApiResponse(
					makeSystemResponse("alpha", [
						{ id: "alpha_poi_1" },
						{ id: "alpha_poi_2" },
						{ id: "alpha_station", hasBase: true },
					]),
				),
			travel: async (poiId: unknown) => {
				poisVisited.push(poiId as string);
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "alpha",
						system_name: "Alpha",
						poi_id: poiId as string,
						poi_name: poiId as string,
					},
				});
				return mockApiResponse({ action: "travel", destination: poiId });
			},
			undock: async () => {
				const loc = currentState.value.location;
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: loc?.system_id ?? "alpha",
						system_name: loc?.system_name ?? "Alpha",
						...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
						...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
					},
				});
				return mockApiResponse({});
			},
			getWrecks: async () => mockApiResponse({ wrecks: [], count: 0 }),
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		await runRoamingSalvageLoop(
			{ ...defaultOptions, loopOptions: { maxIterations: 4, retryDelayMs: 0 } },
			ctx,
		);

		// Should have navigated to alpha (not home, not station)
		expect(poisVisited).toContain("alpha_poi_1");
		expect(poisVisited).toContain("alpha_poi_2");
		expect(poisVisited).not.toContain("alpha_station");
	});

	test("skips POIs with has_base true (stations)", async () => {
		const currentState = { value: makeState() };
		const poisVisited: string[] = [];

		const endpoints = createMockEndpoints({
			getState: async () => mockApiResponse({ ship: currentState.value.ship }),
			getMap: async () =>
				mockApiResponse({
					systems: makeMap([
						{ id: "home", connections: ["beta"] },
						{ id: "beta", connections: ["home"] },
					]),
				}),
			findRoute: async () =>
				mockApiResponse({
					found: true,
					estimated_fuel: 5,
					fuel_per_jump: 5,
					total_jumps: 1,
					route: [{ system_id: "beta" }],
				}),
			jump: async () => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: "beta", system_name: "Beta" },
				});
				return mockApiResponse({ action: "jump", destination: "beta" });
			},
			getSystem: async () =>
				mockApiResponse(
					makeSystemResponse("beta", [
						{ id: "beta_belt" },
						{ id: "beta_dock", hasBase: true }, // should be skipped
						{ id: "beta_nebula" },
					]),
				),
			travel: async (poiId: unknown) => {
				poisVisited.push(poiId as string);
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "beta",
						system_name: "Beta",
						poi_id: poiId as string,
						poi_name: poiId as string,
					},
				});
				return mockApiResponse({ action: "travel", destination: poiId });
			},
			undock: async () => {
				const loc = currentState.value.location;
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: loc?.system_id ?? "beta",
						system_name: "Beta",
						...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
						...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
					},
				});
				return mockApiResponse({});
			},
			getWrecks: async () => mockApiResponse({ wrecks: [], count: 0 }),
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		await runRoamingSalvageLoop(
			{ ...defaultOptions, loopOptions: { maxIterations: 4, retryDelayMs: 0 } },
			ctx,
		);

		expect(poisVisited).toContain("beta_belt");
		expect(poisVisited).toContain("beta_nebula");
		expect(poisVisited).not.toContain("beta_dock");
	});

	test("returns home when cargo is full and resumes remaining POIs after deposit", async () => {
		const currentState = { value: makeState() };
		const poisVisited: string[] = [];
		let prepareAtStationCalled = 0;
		let depositCalled = 0;

		const endpoints = createMockEndpoints({
			getState: async () => mockApiResponse({ ship: currentState.value.ship }),
			getMap: async () =>
				mockApiResponse({
					systems: makeMap([
						{ id: "home", connections: ["gamma"] },
						{ id: "gamma", connections: ["home"] },
					]),
				}),
			findRoute: async (targetId: unknown) =>
				mockApiResponse({
					found: true,
					estimated_fuel: 5,
					fuel_per_jump: 5,
					total_jumps: 1,
					route: [{ system_id: targetId }],
				}),
			jump: async (id: unknown) => {
				const systemId = id as string;
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: systemId, system_name: systemId },
				});
				return mockApiResponse({ action: "jump", destination: id });
			},
			getSystem: async () =>
				mockApiResponse(
					makeSystemResponse("gamma", [{ id: "gamma_poi_1" }, { id: "gamma_poi_2" }]),
				),
			travel: async (poiId: unknown) => {
				poisVisited.push(poiId as string);
				const id = poiId as string;
				const isHome = id === "home_station_poi";
				const cargoFull = poisVisited.filter((p) => p === "gamma_poi_1").length >= 1;
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: isHome ? "home" : "gamma",
						system_name: isHome ? "Home System" : "Gamma",
						poi_id: id,
						poi_name: id,
					},
					// After visiting poi_1, fill cargo with items so EnsureEmptyCargo can deposit them
					cargo: cargoFull
						? [{ item_id: "iron_ore", quantity: 100, item_name: "Iron Ore", size: 1 }]
						: [],
					ship: cargoFull
						? { ...defaultShip, cargo_used: 100, cargo_capacity: 100 }
						: { ...defaultShip },
				});
				return mockApiResponse({ action: "travel", destination: poiId });
			},
			undock: async () => {
				const loc = currentState.value.location;
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: loc?.system_id ?? "home",
						system_name: loc?.system_name ?? "Home",
						...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
						...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
					},
				});
				return mockApiResponse({});
			},
			dock: async () => {
				prepareAtStationCalled++;
				const loc = currentState.value.location;
				currentState.value = makeState({
					...currentState.value,
					ship: { ...defaultShip, cargo_used: 0 },
					location: { ...loc, docked_at: "home_base" },
				});
				return mockApiResponse({ action: "dock" });
			},
			refuel: async () => mockApiResponse({ action: "refuel", fuel: 200 }),
			repair: async () => mockApiResponse({ action: "repair", hull: 100 }),
			getCargo: async () => mockApiResponse({ cargo: currentState.value.cargo ?? [] }),
			depositToStorageBulk: async (items: unknown) => {
				depositCalled++;
				currentState.value = makeState({
					...currentState.value,
					cargo: [],
					ship: { ...defaultShip, cargo_used: 0 },
				});
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			getWrecks: async () => mockApiResponse({ wrecks: [], count: 0 }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		await runRoamingSalvageLoop(
			{ ...defaultOptions, loopOptions: { maxIterations: 10, retryDelayMs: 0 } },
			ctx,
		);

		// Should have visited both gamma POIs (after returning home mid-sweep)
		expect(poisVisited).toContain("gamma_poi_1");
		expect(poisVisited).toContain("gamma_poi_2");
		// Should have returned home to deposit
		expect(prepareAtStationCalled).toBeGreaterThan(0);
		expect(depositCalled).toBeGreaterThan(0);
	});

	test("returns home when fuel is low before visiting a POI", async () => {
		const currentState = {
			value: makeState({ ship: { ...defaultShip, fuel: 8, max_fuel: 200 } }),
		};
		let prepareAtStationCalled = false;

		const endpoints = createMockEndpoints({
			getState: async () => mockApiResponse({ ship: currentState.value.ship }),
			getMap: async () =>
				mockApiResponse({
					systems: makeMap([
						{ id: "home", connections: ["delta"] },
						{ id: "delta", connections: ["home"] },
					]),
				}),
			findRoute: async (targetId: unknown) =>
				// estimated_fuel: 5, minFuelReserve: 10 → need 15, have 8 → must return home
				mockApiResponse({
					found: true,
					estimated_fuel: 5,
					fuel_per_jump: 5,
					total_jumps: 1,
					route: [{ system_id: targetId }],
				}),
			jump: async () => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: "delta", system_name: "Delta" },
				});
				return mockApiResponse({ action: "jump", destination: "delta" });
			},
			getSystem: async () => mockApiResponse(makeSystemResponse("delta", [{ id: "delta_poi_1" }])),
			travel: async (poiId: unknown) => {
				const id = poiId as string;
				const isHome = id === "home_station_poi";
				currentState.value = makeState({
					...currentState.value,
					ship: isHome ? { ...defaultShip, fuel: 200 } : currentState.value.ship,
					location: {
						system_id: isHome ? "home" : "delta",
						system_name: isHome ? "Home System" : "Delta",
						poi_id: id,
						poi_name: id,
					},
				});
				return mockApiResponse({ action: "travel", destination: poiId });
			},
			undock: async () => {
				const loc = currentState.value.location;
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: loc?.system_id ?? "home",
						system_name: loc?.system_name ?? "Home",
						...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
						...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
					},
				});
				return mockApiResponse({});
			},
			dock: async () => {
				prepareAtStationCalled = true;
				const loc = currentState.value.location;
				currentState.value = makeState({
					...currentState.value,
					ship: { ...defaultShip, fuel: 200 },
					location: { ...loc, docked_at: "home_base" },
				});
				return mockApiResponse({ action: "dock" });
			},
			refuel: async () => mockApiResponse({ action: "refuel", fuel: 200 }),
			repair: async () => mockApiResponse({ action: "repair", hull: 100 }),
			getCargo: async () => mockApiResponse({ cargo: [] }),
			getWrecks: async () => mockApiResponse({ wrecks: [], count: 0 }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		await runRoamingSalvageLoop(
			{ ...defaultOptions, minFuelReserve: 10, loopOptions: { maxIterations: 5, retryDelayMs: 0 } },
			ctx,
		);

		expect(prepareAtStationCalled).toBe(true);
	});

	test("loots wrecks when present at POI", async () => {
		const currentState = { value: makeState() };
		let lootCalled = false;

		const endpoints = createMockEndpoints({
			getState: async () => mockApiResponse({ ship: currentState.value.ship }),
			getMap: async () =>
				mockApiResponse({
					systems: makeMap([
						{ id: "home", connections: ["epsilon"] },
						{ id: "epsilon", connections: ["home"] },
					]),
				}),
			findRoute: async (targetId: unknown) =>
				mockApiResponse({
					found: true,
					estimated_fuel: 5,
					fuel_per_jump: 5,
					total_jumps: 1,
					route: [{ system_id: targetId }],
				}),
			jump: async (id: unknown) => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: id as string, system_name: id as string },
				});
				return mockApiResponse({ action: "jump", destination: id });
			},
			getSystem: async () =>
				mockApiResponse(makeSystemResponse("epsilon", [{ id: "epsilon_belt" }])),
			travel: async (poiId: unknown) => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "epsilon",
						system_name: "Epsilon",
						poi_id: poiId as string,
						poi_name: poiId as string,
					},
				});
				return mockApiResponse({ action: "travel", destination: poiId });
			},
			undock: async () => {
				const loc = currentState.value.location;
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: loc?.system_id ?? "epsilon",
						system_name: "Epsilon",
						...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
						...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
					},
				});
				return mockApiResponse({});
			},
			getWrecks: async () => mockApiResponse({ wrecks: [makeWreck("w1")], count: 1 }),
			lootWreck: async () => {
				lootCalled = true;
				return mockApiResponse({ action: "loot", quantity: 5, wreck_empty: true });
			},
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		await runRoamingSalvageLoop(
			{ ...defaultOptions, loopOptions: { maxIterations: 3, retryDelayMs: 0 } },
			ctx,
		);

		expect(lootCalled).toBe(true);
	});

	test("resets sweep and revisits systems when all empire systems visited", async () => {
		const currentState = { value: makeState() };
		let getSystemCallCount = 0;

		const endpoints = createMockEndpoints({
			getState: async () => mockApiResponse({ ship: currentState.value.ship }),
			getMap: async () =>
				mockApiResponse({
					systems: makeMap([
						{ id: "home", connections: ["zeta"] },
						{ id: "zeta", connections: ["home"] },
					]),
				}),
			findRoute: async (targetId: unknown) =>
				mockApiResponse({
					found: true,
					estimated_fuel: 5,
					fuel_per_jump: 5,
					total_jumps: 1,
					route: [{ system_id: targetId }],
				}),
			jump: async (id: unknown) => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: id as string, system_name: id as string },
				});
				return mockApiResponse({ action: "jump", destination: id });
			},
			getSystem: async () => {
				getSystemCallCount++;
				return mockApiResponse(makeSystemResponse("zeta", [{ id: "zeta_poi" }]));
			},
			travel: async (poiId: unknown) => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: "zeta",
						system_name: "Zeta",
						poi_id: poiId as string,
						poi_name: poiId as string,
					},
				});
				return mockApiResponse({ action: "travel", destination: poiId });
			},
			undock: async () => {
				const loc = currentState.value.location;
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: loc?.system_id ?? "zeta",
						system_name: "Zeta",
						...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
						...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
					},
				});
				return mockApiResponse({});
			},
			getWrecks: async () => mockApiResponse({ wrecks: [], count: 0 }),
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		// Run enough iterations to complete one sweep and start the second
		await runRoamingSalvageLoop(
			{ ...defaultOptions, loopOptions: { maxIterations: 8, retryDelayMs: 0 } },
			ctx,
		);

		// getSystem should be called more than once (at least twice — once per sweep pass through zeta)
		expect(getSystemCallCount).toBeGreaterThan(1);
	});

	test("does not visit lawless systems when allowLawless is false (default)", async () => {
		const currentState = { value: makeState() };
		const systemsNavigatedTo: string[] = [];

		const endpoints = createMockEndpoints({
			getState: async () => mockApiResponse({ ship: currentState.value.ship }),
			getMap: async () =>
				mockApiResponse({
					systems: makeMap([
						{ id: "home", empire: "solarian", connections: ["lawless_sys", "empire_sys"] },
						{ id: "lawless_sys", empire: "", connections: ["home"] },
						{ id: "empire_sys", empire: "solarian", connections: ["home"] },
					]),
				}),
			findRoute: async (targetId: unknown) => {
				systemsNavigatedTo.push(targetId as string);
				return mockApiResponse({
					found: true,
					estimated_fuel: 5,
					fuel_per_jump: 5,
					total_jumps: 1,
					route: [{ system_id: targetId }],
				});
			},
			jump: async (id: unknown) => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: id as string, system_name: id as string },
				});
				return mockApiResponse({ action: "jump", destination: id });
			},
			getSystem: async (sysId: unknown) =>
				mockApiResponse(makeSystemResponse(sysId as string, [{ id: `${sysId as string}_poi` }])),
			travel: async (poiId: unknown) => {
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: currentState.value.location?.system_id ?? "home",
						system_name: "System",
						poi_id: poiId as string,
						poi_name: poiId as string,
					},
				});
				return mockApiResponse({ action: "travel", destination: poiId });
			},
			undock: async () => {
				const loc = currentState.value.location;
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: loc?.system_id ?? "home",
						system_name: "System",
						...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
						...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
					},
				});
				return mockApiResponse({});
			},
			getWrecks: async () => mockApiResponse({ wrecks: [], count: 0 }),
			getCargo: async () => mockApiResponse({ cargo: [] }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		await runRoamingSalvageLoop(
			{
				...defaultOptions,
				allowLawless: false,
				loopOptions: { maxIterations: 5, retryDelayMs: 0 },
			},
			ctx,
		);

		// Should never navigate to the lawless system
		expect(systemsNavigatedTo).not.toContain("lawless_sys");
		expect(systemsNavigatedTo).toContain("empire_sys");
	});

	test("deposits to faction storage when depositTarget is faction", async () => {
		const currentState = {
			value: makeState({
				ship: { ...defaultShip, cargo_used: 100, cargo_capacity: 100 },
				cargo: [{ item_id: "iron_ore", quantity: 100, item_name: "Iron Ore", size: 1 }],
			}),
		};
		let factionDepositCalled = false;
		let personalDepositCalled = false;

		const endpoints = createMockEndpoints({
			getState: async () => mockApiResponse({ ship: currentState.value.ship }),
			getMap: async () =>
				mockApiResponse({
					systems: makeMap([
						{ id: "home", connections: ["eta"] },
						{ id: "eta", connections: ["home"] },
					]),
				}),
			findRoute: async (targetId: unknown) =>
				mockApiResponse({
					found: true,
					estimated_fuel: 5,
					fuel_per_jump: 5,
					total_jumps: 1,
					route: [{ system_id: targetId }],
				}),
			jump: async (id: unknown) => {
				currentState.value = makeState({
					...currentState.value,
					location: { system_id: id as string, system_name: id as string },
				});
				return mockApiResponse({ action: "jump", destination: id });
			},
			travel: async (poiId: unknown) => {
				const id = poiId as string;
				const isHome = id === "home_station_poi";
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: isHome ? "home" : "eta",
						system_name: isHome ? "Home System" : "Eta",
						poi_id: id,
						poi_name: id,
					},
				});
				return mockApiResponse({ action: "travel", destination: poiId });
			},
			dock: async () => {
				const loc = currentState.value.location;
				currentState.value = makeState({
					...currentState.value,
					location: { ...loc, docked_at: "home_base" },
				});
				return mockApiResponse({ action: "dock" });
			},
			refuel: async () => mockApiResponse({ action: "refuel", fuel: 200 }),
			repair: async () => mockApiResponse({ action: "repair", hull: 100 }),
			getCargo: async () => mockApiResponse({ cargo: currentState.value.cargo ?? [] }),
			depositToFactionStorageBulk: async (items: unknown) => {
				factionDepositCalled = true;
				currentState.value = makeState({
					...currentState.value,
					cargo: [],
					ship: { ...defaultShip, cargo_used: 0 },
				});
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			depositToStorageBulk: async () => {
				personalDepositCalled = true;
				return mockApiResponse({
					action: "deposit",
					requested: 0,
					succeeded: 0,
					failed: 0,
					results: [],
				});
			},
			undock: async () => {
				const loc = currentState.value.location;
				currentState.value = makeState({
					...currentState.value,
					location: {
						system_id: loc?.system_id ?? "home",
						system_name: loc?.system_name ?? "Home",
						...(loc?.poi_id ? { poi_id: loc.poi_id } : {}),
						...(loc?.poi_name ? { poi_name: loc.poi_name } : {}),
					},
				});
				return mockApiResponse({});
			},
			getWrecks: async () => mockApiResponse({ wrecks: [], count: 0 }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState.value,
			refreshState: async () => currentState.value,
		};

		await runRoamingSalvageLoop(
			{
				...defaultOptions,
				depositTarget: "faction",
				loopOptions: { maxIterations: 1, retryDelayMs: 0 },
			},
			ctx,
		);

		expect(factionDepositCalled).toBe(true);
		expect(personalDepositCalled).toBe(false);
	});
});
