import { describe, expect, test } from "bun:test";
import type { GoalContext } from "../../src/dispatcher/goals.js";
import { InstallMod } from "../../src/dispatcher/primitives/install-mod.js";
import { UninstallMod } from "../../src/dispatcher/primitives/uninstall-mod.js";
import type { StoredGameState } from "../../src/state/store.js";
import { createMockEndpoints, mockApiResponse } from "../fixtures/mock-endpoints.js";

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: { id: "p1", username: "Test", credits: 1000 },
		ship: { id: "s1", hull: 100, max_hull: 100, fuel: 50, max_fuel: 50 },
		cargo: [],
		location: {
			system_id: "sol",
			system_name: "Sol",
			poi_id: "sol_station",
			poi_name: "Station",
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

// ── InstallMod ───────────────────────────────────────────────────────

describe("InstallMod", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new InstallMod({ moduleId: "mod-1" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("docked");
	});

	test("already satisfied when module is installed", async () => {
		const state = makeState({
			modules: [{ module_id: "mod-1", name: "Mining Laser" }] as StoredGameState["modules"],
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new InstallMod({ moduleId: "mod-1" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("installs module successfully", async () => {
		const state = makeState({ modules: [] as StoredGameState["modules"] });
		const endpoints = createMockEndpoints({
			installMod: async () =>
				mockApiResponse({
					module_id: "mod-1",
					message: "Module installed",
					quality: 3,
					cpu_used: 10,
					power_used: 5,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new InstallMod({ moduleId: "mod-1" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("mod-1");
		expect(result.message).toContain("mod-1");
	});

	test("installs when modules state is undefined", async () => {
		const state = makeState(); // modules: undefined
		const endpoints = createMockEndpoints({
			installMod: async () =>
				mockApiResponse({
					module_id: "mod-1",
					message: "Module installed",
					quality: 3,
					cpu_used: 10,
					power_used: 5,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new InstallMod({ moduleId: "mod-1" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
	});
});

// ── UninstallMod ─────────────────────────────────────────────────────

describe("UninstallMod", () => {
	test("fails when not docked", async () => {
		const state = makeState({
			location: { system_id: "sol", system_name: "Sol" },
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new UninstallMod({ moduleId: "mod-1" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(false);
		expect(result.message).toContain("docked");
	});

	test("already satisfied when module is not installed", async () => {
		const state = makeState({
			modules: [{ module_id: "mod-other" }] as StoredGameState["modules"],
		});
		const endpoints = createMockEndpoints();
		const ctx: GoalContext = { endpoints, state };

		const goal = new UninstallMod({ moduleId: "mod-1" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.alreadySatisfied).toBe(true);
	});

	test("uninstalls module successfully", async () => {
		const state = makeState({
			modules: [{ module_id: "mod-1" }] as StoredGameState["modules"],
		});
		const endpoints = createMockEndpoints({
			uninstallMod: async () =>
				mockApiResponse({
					module_id: "mod-1",
					message: "Module uninstalled",
					cpu_used: 5,
					power_used: 3,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new UninstallMod({ moduleId: "mod-1" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
		expect(result.message).toContain("mod-1");
	});

	test("reports when module is destroyed on removal", async () => {
		const state = makeState({
			modules: [{ module_id: "mod-1" }] as StoredGameState["modules"],
		});
		const endpoints = createMockEndpoints({
			uninstallMod: async () =>
				mockApiResponse({
					module_id: "mod-1",
					message: "Module destroyed",
					destroyed: true,
					cpu_used: 0,
					power_used: 0,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new UninstallMod({ moduleId: "mod-1" });
		const result = await goal.execute(ctx);

		expect(result.success).toBe(true);
		expect(result.message).toContain("destroyed");
	});

	test("uninstalls when modules state is undefined", async () => {
		const state = makeState(); // modules: undefined — can't check, just try
		const endpoints = createMockEndpoints({
			uninstallMod: async () =>
				mockApiResponse({
					module_id: "mod-1",
					message: "Module uninstalled",
					cpu_used: 5,
					power_used: 3,
				}),
		});
		const ctx: GoalContext = { endpoints, state };

		const goal = new UninstallMod({ moduleId: "mod-1" });
		const result = await goal.execute(ctx);

		// When modules state is undefined, we can't check if installed,
		// so it proceeds to try uninstalling
		expect(result.success).toBe(true);
		expect(result.ticksUsed).toBe(1);
	});
});
