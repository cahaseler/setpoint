import { describe, expect, test } from "bun:test";
import { EnsureLoadout } from "../../../src/dispatcher/compounds/ensure-loadout.js";
import type { GoalContext } from "../../../src/dispatcher/goals.js";
import type { StoredGameState } from "../../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../../fixtures/mock-endpoints.js";

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 10000 },
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
		modules: [],
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function makeModule(typeId: string, moduleId: string): Record<string, unknown> {
	return {
		module_id: moduleId,
		type_id: typeId,
		type: typeId,
		name: typeId.replace(/_/g, " "),
		cpu_usage: 10,
		power_usage: 10,
		quality: 1,
	};
}

const defaultOptions = {
	systemId: "sol",
	poiId: "sol_station",
	baseId: "sol_base",
};

describe("EnsureLoadout", () => {
	test("already has the right loadout → alreadySatisfied", async () => {
		const currentState = makeState({
			modules: [makeModule("mining_laser_1", "ml-001"), makeModule("shield_booster_2", "sb-001")],
		});

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["mining_laser_1", "shield_booster_2"],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("installs modules from personal storage", async () => {
		let currentState = makeState({ modules: [] });

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "mining_laser_1", item_name: "Mining Laser", quantity: 1 }],
				}),
			viewFactionStorage: async () => mockApiResponse({ action: "view", items: [] }),
			withdrawFromStorage: async () => {
				currentState = makeState({
					...currentState,
					cargo: [{ item_id: "mining_laser_1", item_name: "Mining Laser", quantity: 1, size: 1 }],
				});
				return mockApiResponse({ action: "withdraw", message: "ok" });
			},
			installMod: async () => {
				currentState = makeState({
					...currentState,
					modules: [makeModule("mining_laser_1", "ml-new")],
					cargo: [],
				});
				return mockApiResponse({
					module_id: "ml-new",
					cpu_used: 10,
					power_used: 10,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["mining_laser_1"],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(false);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("falls back to faction storage when not in personal", async () => {
		let currentState = makeState({ modules: [] });

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			viewStorage: async () => mockApiResponse({ action: "view", items: [] }),
			viewFactionStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "mining_laser_1", item_name: "Mining Laser", quantity: 1 }],
				}),
			withdrawFromFactionStorage: async () => {
				currentState = makeState({
					...currentState,
					cargo: [{ item_id: "mining_laser_1", item_name: "Mining Laser", quantity: 1, size: 1 }],
				});
				return mockApiResponse({ action: "withdraw", message: "ok" });
			},
			installMod: async () => {
				currentState = makeState({
					...currentState,
					modules: [makeModule("mining_laser_1", "ml-new")],
					cargo: [],
				});
				return mockApiResponse({
					module_id: "ml-new",
					cpu_used: 10,
					power_used: 10,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["mining_laser_1"],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
	});

	test("falls back to market when not in either storage", async () => {
		let currentState = makeState({ modules: [] });

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			viewStorage: async () => mockApiResponse({ action: "view", items: [] }),
			viewFactionStorage: async () => mockApiResponse({ action: "view", items: [] }),
			viewMarket: async () =>
				mockApiResponse({
					action: "view_market",
					items: [
						{
							item_id: "mining_laser_1",
							item_name: "Mining Laser",
							best_buy: 0,
							best_sell: 100,
							buy_price: 0,
							buy_quantity: 0,
							sell_price: 100,
							sell_quantity: 5,
							buy_orders: [],
							sell_orders: [{ price_each: 100, quantity: 5 }],
						},
					],
				}),
			buy: async () => {
				currentState = makeState({
					...currentState,
					cargo: [{ item_id: "mining_laser_1", item_name: "Mining Laser", quantity: 1, size: 1 }],
				});
				return mockApiResponse({
					action: "buy",
					item_id: "mining_laser_1",
					quantity: 1,
					total_cost: 100,
				});
			},
			installMod: async () => {
				currentState = makeState({
					...currentState,
					modules: [makeModule("mining_laser_1", "ml-new")],
					cargo: [],
				});
				return mockApiResponse({
					module_id: "ml-new",
					cpu_used: 10,
					power_used: 10,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["mining_laser_1"],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
	});

	test("uninstalls unwanted modules and deposits to configured storage", async () => {
		let currentState = makeState({
			modules: [makeModule("old_laser", "ol-001"), makeModule("mining_laser_1", "ml-001")],
		});

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			uninstallMod: async () => {
				currentState = makeState({
					...currentState,
					modules: [makeModule("mining_laser_1", "ml-001")],
					cargo: [{ item_id: "old_laser", item_name: "Old Laser", quantity: 1, size: 1 }],
				});
				return mockApiResponse({
					module_id: "ol-001",
					message: "Uninstalled",
					cpu_used: 0,
					power_used: 0,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["mining_laser_1"],
			uninstalledStorage: "personal",
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("handles module destroyed on uninstall", async () => {
		let currentState = makeState({
			modules: [makeModule("old_laser", "ol-001"), makeModule("mining_laser_1", "ml-001")],
		});

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			uninstallMod: async () => {
				currentState = makeState({
					...currentState,
					modules: [makeModule("mining_laser_1", "ml-001")],
					cargo: [],
				});
				return mockApiResponse({
					module_id: "ol-001",
					message: "Destroyed on removal",
					destroyed: true,
					cpu_used: 0,
					power_used: 0,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["mining_laser_1"],
		});

		const result = await goal.execute(ctx);

		// Should succeed despite module being destroyed (expected edge case)
		expect(result.success).toBe(true);
	});

	test("loads ammo into weapons via reload", async () => {
		let currentState = makeState({
			modules: [makeModule("plasma_cannon_1", "pc-001")],
		});

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "plasma_round", item_name: "Plasma Round", quantity: 10 }],
				}),
			withdrawFromStorage: async () => {
				currentState = makeState({
					...currentState,
					cargo: [{ item_id: "plasma_round", item_name: "Plasma Round", quantity: 10, size: 1 }],
				});
				return mockApiResponse({ action: "withdraw", message: "ok" });
			},
			reload: async () => {
				currentState = makeState({
					...currentState,
					cargo: [],
				});
				return mockApiResponse({
					action: "reload",
					weapon_id: "pc-001",
					weapon_name: "Plasma Cannon",
					ammo_id: "plasma_round",
					ammo_name: "Plasma Round",
					current_ammo: 10,
					magazine_size: 10,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["plasma_cannon_1"],
			ammo: { plasma_cannon_1: "plasma_round" },
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
	});

	test("fails when module not found in any source", async () => {
		const currentState = makeState({ modules: [] });

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			viewStorage: async () => mockApiResponse({ action: "view", items: [] }),
			viewFactionStorage: async () => mockApiResponse({ action: "view", items: [] }),
			viewMarket: async () => mockApiResponse({ action: "view_market", items: [] }),
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["nonexistent_module"],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("Could not source nonexistent_module");
	});

	test("fails when weapon type_id not found for ammo mapping", async () => {
		const currentState = makeState({
			modules: [makeModule("mining_laser_1", "ml-001")],
		});

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["mining_laser_1"],
			ammo: { plasma_cannon_1: "plasma_round" },
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("weapon type plasma_cannon_1 is not installed");
	});

	test("installs multiple copies of the same module type (Bug 2 fix)", async () => {
		// Desired: 2x gas_harvester_i; currently installed: 0
		let currentState = makeState({ modules: [] });
		let installCallCount = 0;

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "gas_harvester_i", item_name: "Gas Harvester I", quantity: 2 }],
				}),
			viewFactionStorage: async () => mockApiResponse({ action: "view", items: [] }),
			withdrawFromStorage: async () => {
				currentState = makeState({
					...currentState,
					cargo: [
						{ item_id: "gas_harvester_i", item_name: "Gas Harvester I", quantity: 1, size: 1 },
					],
				});
				return mockApiResponse({ action: "withdraw", message: "ok" });
			},
			installMod: async () => {
				installCallCount++;
				const existing = currentState.modules ?? [];
				currentState = makeState({
					...currentState,
					modules: [
						...(existing as ReturnType<typeof makeModule>[]),
						makeModule("gas_harvester_i", `gh-00${installCallCount}`),
					],
					cargo: [],
				});
				return mockApiResponse({
					module_id: `gh-00${installCallCount}`,
					cpu_used: 10,
					power_used: 10,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["gas_harvester_i", "gas_harvester_i"],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(installCallCount).toBe(2);
	});

	test("uninstalls excess copies of same type, installs missing copies (Bug 1 + Bug 2 fix)", async () => {
		// Have: 3x gas_harvester_i (1 extra). Want: 2x gas_harvester_i.
		let currentState = makeState({
			modules: [
				makeModule("gas_harvester_i", "gh-001"),
				makeModule("gas_harvester_i", "gh-002"),
				makeModule("gas_harvester_i", "gh-003"),
			],
		});
		let uninstallCallCount = 0;

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			uninstallMod: async () => {
				uninstallCallCount++;
				const mods = (currentState.modules ?? []) as ReturnType<typeof makeModule>[];
				currentState = makeState({
					...currentState,
					modules: mods.slice(0, mods.length - 1),
					cargo: [
						{ item_id: "gas_harvester_i", item_name: "Gas Harvester I", quantity: 1, size: 1 },
					],
				});
				return mockApiResponse({
					module_id: "gh-003",
					message: "Uninstalled",
					cpu_used: 0,
					power_used: 0,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["gas_harvester_i", "gas_harvester_i"],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(uninstallCallCount).toBe(1);
	});

	test("uninstalls all slots before installing when all slots occupied by wrong types (Bug 1 fix)", async () => {
		// Have: 2 slots full of bad modules. Want: 2 different modules. Must uninstall first.
		let currentState = makeState({
			modules: [makeModule("bad_module_a", "bm-001"), makeModule("bad_module_b", "bm-002")],
		});
		let uninstallCallCount = 0;
		let installCallCount = 0;

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			uninstallMod: async () => {
				uninstallCallCount++;
				const mods = (currentState.modules ?? []) as ReturnType<typeof makeModule>[];
				currentState = makeState({
					...currentState,
					modules: mods.slice(0, mods.length - 1),
					cargo: [{ item_id: "bad_module_a", item_name: "Bad", quantity: 1, size: 1 }],
				});
				return mockApiResponse({
					module_id: "bm-001",
					message: "Uninstalled",
					cpu_used: 0,
					power_used: 0,
				});
			},
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [{ item_id: "gas_harvester_i", item_name: "Gas Harvester I", quantity: 2 }],
				}),
			viewFactionStorage: async () => mockApiResponse({ action: "view", items: [] }),
			withdrawFromStorage: async () => {
				currentState = makeState({
					...currentState,
					cargo: [
						{ item_id: "gas_harvester_i", item_name: "Gas Harvester I", quantity: 1, size: 1 },
					],
				});
				return mockApiResponse({ action: "withdraw", message: "ok" });
			},
			installMod: async () => {
				installCallCount++;
				const mods = (currentState.modules ?? []) as ReturnType<typeof makeModule>[];
				currentState = makeState({
					...currentState,
					modules: [...mods, makeModule("gas_harvester_i", `gh-00${installCallCount}`)],
					cargo: [],
				});
				return mockApiResponse({
					module_id: `gh-00${installCallCount}`,
					cpu_used: 10,
					power_used: 10,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["gas_harvester_i", "gas_harvester_i"],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(uninstallCallCount).toBe(2);
		expect(installCallCount).toBe(2);
	});

	test("stops uninstalling when the abort signal fires between modules", async () => {
		// Two modules to remove; desired loadout is empty so both are uninstalled.
		let currentState = makeState({
			modules: [makeModule("old_laser_a", "ol-001"), makeModule("old_laser_b", "ol-002")],
		});
		const controller = new AbortController();
		let uninstallCallCount = 0;

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			uninstallMod: async () => {
				uninstallCallCount++;
				const mods = (currentState.modules ?? []) as ReturnType<typeof makeModule>[];
				currentState = makeState({
					...currentState,
					modules: mods.slice(0, mods.length - 1),
					cargo: [],
				});
				// Force abort lands while the first module is being uninstalled —
				// another module still needs removing, so only the signal stops the loop.
				controller.abort();
				return mockApiResponse({
					module_id: "ol-001",
					message: "Uninstalled",
					cpu_used: 0,
					power_used: 0,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			signal: controller.signal,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: [],
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("aborted");
		expect(uninstallCallCount).toBe(1);
	});

	test("full end-to-end: uninstall old → source new → install → load ammo → cleanup", async () => {
		let currentState = makeState({
			modules: [makeModule("old_laser", "ol-001")],
		});

		let uninstallCalled = false;
		let installCalled = false;
		let reloadCalled = false;

		const endpoints = createMockEndpoints({
			refuel: async () => mockApiResponse({}),
			getCargo: async () => mockApiResponse({ cargo: currentState.cargo }),
			depositToStorage: async () => mockApiResponse({ action: "deposit", message: "ok" }),
			depositToStorageBulk: async (items: unknown) => {
				const list = items as Array<{ itemId: string; quantity: number }>;
				return mockApiResponse({
					action: "deposit",
					requested: list.length,
					succeeded: list.length,
					failed: 0,
					results: list.map((it) => ({ item_id: it.itemId, quantity: it.quantity, success: true })),
				});
			},
			uninstallMod: async () => {
				uninstallCalled = true;
				currentState = makeState({
					...currentState,
					modules: [],
					cargo: [{ item_id: "old_laser", item_name: "Old Laser", quantity: 1, size: 1 }],
				});
				return mockApiResponse({
					module_id: "ol-001",
					message: "Uninstalled",
					cpu_used: 0,
					power_used: 0,
				});
			},
			viewStorage: async () =>
				mockApiResponse({
					action: "view",
					items: [
						{ item_id: "plasma_cannon_1", item_name: "Plasma Cannon", quantity: 1 },
						{ item_id: "plasma_round", item_name: "Plasma Round", quantity: 10 },
					],
				}),
			viewFactionStorage: async () => mockApiResponse({ action: "view", items: [] }),
			withdrawFromStorage: async (_itemId: unknown) => {
				const itemId = _itemId as string;
				const existingCargo = currentState.cargo ?? [];
				const existingItem = existingCargo.find(
					(c: Record<string, unknown>) => c["item_id"] === itemId,
				);
				const newCargo = existingItem
					? existingCargo
					: [...existingCargo, { item_id: itemId, name: itemId, quantity: 1, size: 1 }];
				currentState = makeState({
					...currentState,
					cargo: newCargo,
				});
				return mockApiResponse({ action: "withdraw", message: "ok" });
			},
			installMod: async () => {
				installCalled = true;
				currentState = makeState({
					...currentState,
					modules: [makeModule("plasma_cannon_1", "pc-new")],
					cargo: (currentState.cargo ?? []).filter(
						(c: Record<string, unknown>) => c["item_id"] !== "plasma_cannon_1",
					),
				});
				return mockApiResponse({
					module_id: "pc-new",
					cpu_used: 10,
					power_used: 10,
				});
			},
			reload: async () => {
				reloadCalled = true;
				currentState = makeState({
					...currentState,
					cargo: (currentState.cargo ?? []).filter(
						(c: Record<string, unknown>) => c["item_id"] !== "plasma_round",
					),
				});
				return mockApiResponse({
					action: "reload",
					weapon_id: "pc-new",
					weapon_name: "Plasma Cannon",
					ammo_id: "plasma_round",
					ammo_name: "Plasma Round",
					current_ammo: 10,
					magazine_size: 10,
				});
			},
		});

		const ctx: GoalContext = {
			endpoints,
			state: currentState,
			refreshState: async () => currentState,
		};

		const goal = new EnsureLoadout({
			...defaultOptions,
			modules: ["plasma_cannon_1"],
			ammo: { plasma_cannon_1: "plasma_round" },
		});

		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(uninstallCalled).toBe(true);
		expect(installCalled).toBe(true);
		expect(reloadCalled).toBe(true);
		expect(result.ticksUsed).toBeGreaterThan(0);
		expect(result.steps.length).toBeGreaterThanOrEqual(4);
	});
});
