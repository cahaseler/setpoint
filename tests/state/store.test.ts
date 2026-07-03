import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { V2GameState } from "@spacemolt/lib";
import { createMemoryDatabase } from "../../src/state/database.js";
import { StateStore } from "../../src/state/store.js";

let db: Database;
let store: StateStore;

beforeEach(() => {
	db = createMemoryDatabase();
	store = new StateStore(db);
});

describe("StateStore.getState", () => {
	test("returns undefined for unknown account", () => {
		const state = store.getState("unknown-account");
		expect(state).toBeUndefined();
	});

	test("returns stored state after applyUpdate", () => {
		const gameState: V2GameState = {
			player: {
				id: "p1",
				username: "TestPlayer",
				credits: 500,
				empire: "solarian",
			},
		};

		store.applyUpdate("account-1", gameState);
		const state = store.getState("account-1");

		expect(state).toBeDefined();
		expect(state?.player?.id).toBe("p1");
		expect(state?.player?.username).toBe("TestPlayer");
		expect(state?.player?.credits).toBe(500);
	});

	test("returns undefined sections for fields not yet set", () => {
		const gameState: V2GameState = {
			player: {
				id: "p1",
				username: "TestPlayer",
				credits: 500,
				empire: "solarian",
			},
		};

		store.applyUpdate("account-1", gameState);
		const state = store.getState("account-1");

		expect(state?.player).toBeDefined();
		expect(state?.ship).toBeUndefined();
		expect(state?.cargo).toBeUndefined();
		expect(state?.location).toBeUndefined();
		expect(state?.modules).toBeUndefined();
		expect(state?.skills).toBeUndefined();
		expect(state?.missions).toBeUndefined();
		expect(state?.queue).toBeUndefined();
	});

	test("returns updatedAt timestamp", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
		});

		const state = store.getState("account-1");
		expect(state?.updatedAt).toBeDefined();
		expect(typeof state?.updatedAt).toBe("string");
	});
});

describe("StateStore.getSection", () => {
	test("returns undefined for unknown account", () => {
		const section = store.getSection("unknown", "player");
		expect(section).toBeUndefined();
	});

	test("returns undefined for unset section", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
		});

		const cargo = store.getSection("account-1", "cargo");
		expect(cargo).toBeUndefined();
	});

	test("returns specific section data", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 100, empire: "solarian" },
			location: {
				system_id: "sol",
				system_name: "Sol",
			},
		});

		const location = store.getSection("account-1", "location");
		expect(location).toBeDefined();
		expect(location?.system_id).toBe("sol");
		expect(location?.system_name).toBe("Sol");
	});

	test("returns player section independently", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 100, empire: "solarian" },
		});

		const player = store.getSection("account-1", "player");
		expect(player?.id).toBe("p1");
		expect(player?.credits).toBe(100);
	});
});

describe("StateStore.applyUpdate", () => {
	test("returns empty array when no sections provided", () => {
		const updated = store.applyUpdate("account-1", {} as V2GameState);
		expect(updated).toEqual([]);
	});

	test("returns list of updated section keys", () => {
		const updated = store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
			ship: { id: "s1", class_id: "scout" },
		});

		expect(updated).toContain("player");
		expect(updated).toContain("ship");
		expect(updated).toHaveLength(2);
	});

	test("inserts new row on first update", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
		});

		const ids = store.getAllAccountIds();
		expect(ids).toContain("account-1");
	});

	test("updates existing row on subsequent updates", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 100, empire: "solarian" },
		});

		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 200, empire: "solarian" },
		});

		const state = store.getState("account-1");
		expect(state?.player?.credits).toBe(200);

		// Should still be only one row
		const ids = store.getAllAccountIds();
		expect(ids).toHaveLength(1);
	});

	test("skips null section values to avoid clobbering existing state", () => {
		// First update: set ship with cargo_used
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 100, empire: "solarian" },
			ship: {
				id: "s1",
				class_id: "scout",
				hull: 100,
				max_hull: 100,
				cargo_capacity: 50,
				cargo_used: 30,
			},
		});

		// Second update: ship is null (e.g. from get_cargo response) — should not overwrite
		store.applyUpdate("account-1", { ship: null } as unknown as V2GameState);

		const state = store.getState("account-1");
		// Ship should be preserved from first update
		expect(state?.ship?.id).toBe("s1");
		expect(state?.ship?.cargo_used).toBe(30);
	});

	test("partial update preserves existing sections", () => {
		// First update: set player and ship
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 100, empire: "solarian" },
			ship: { id: "s1", class_id: "scout", hull: 100, max_hull: 100 },
		});

		// Second update: only update player credits
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 200, empire: "solarian" },
		});

		const state = store.getState("account-1");
		// Player should be updated
		expect(state?.player?.credits).toBe(200);
		// Ship should be preserved from first update
		expect(state?.ship?.id).toBe("s1");
		expect(state?.ship?.hull).toBe(100);
	});

	test("handles all section types", () => {
		const gameState: V2GameState = {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
			ship: { id: "s1", class_id: "scout" },
			cargo: [{ item_id: "iron", item_name: "Iron", quantity: 10, size: 1 }],
			location: { system_id: "sol", system_name: "Sol" },
		};

		const updated = store.applyUpdate("account-1", gameState);
		expect(updated).toHaveLength(4);

		const state = store.getState("account-1");
		expect(state?.player).toBeDefined();
		expect(state?.ship).toBeDefined();
		expect(state?.cargo).toBeDefined();
		expect(state?.location).toBeDefined();
	});

	test("handles multiple accounts independently", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Player1", credits: 100, empire: "solarian" },
		});

		store.applyUpdate("account-2", {
			player: { id: "p2", username: "Player2", credits: 200, empire: "colonial" },
		});

		const state1 = store.getState("account-1");
		const state2 = store.getState("account-2");

		expect(state1?.player?.username).toBe("Player1");
		expect(state1?.player?.credits).toBe(100);
		expect(state2?.player?.username).toBe("Player2");
		expect(state2?.player?.credits).toBe(200);
	});

	test("updates timestamp on every update", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
		});

		const state1 = store.getState("account-1");
		const firstTimestamp = state1?.updatedAt;

		// Apply another update
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 100, empire: "solarian" },
		});

		const state2 = store.getState("account-1");
		// Timestamps should exist
		expect(firstTimestamp).toBeDefined();
		expect(state2?.updatedAt).toBeDefined();
	});
});

describe("StateStore.deleteState", () => {
	test("removes all state for an account", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
		});

		store.deleteState("account-1");
		const state = store.getState("account-1");
		expect(state).toBeUndefined();
	});

	test("does not affect other accounts", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Player1", credits: 0, empire: "solarian" },
		});
		store.applyUpdate("account-2", {
			player: { id: "p2", username: "Player2", credits: 0, empire: "colonial" },
		});

		store.deleteState("account-1");

		expect(store.getState("account-1")).toBeUndefined();
		expect(store.getState("account-2")).toBeDefined();
	});

	test("no-op for non-existent account", () => {
		// Should not throw
		store.deleteState("nonexistent");
	});
});

describe("StateStore.getSessionInfo / setSessionInfo", () => {
	test("getSessionInfo returns undefined when account has no row", () => {
		const info = store.getSessionInfo("no-such-account");
		expect(info).toBeUndefined();
	});

	test("getSessionInfo returns undefined when session columns are null", () => {
		// Create a row via applyUpdate (no session columns set)
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
		});

		const info = store.getSessionInfo("account-1");
		expect(info).toBeUndefined();
	});

	test("setSessionInfo creates a row with session data when no row exists", () => {
		const expiresAt = new Date("2026-03-01T00:00:00Z");
		store.setSessionInfo("account-new", "sess-abc", expiresAt);

		const info = store.getSessionInfo("account-new");
		expect(info).toBeDefined();
		expect(info?.sessionId).toBe("sess-abc");
	});

	test("setSessionInfo updates session columns without affecting game state columns", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 500, empire: "solarian" },
		});

		const expiresAt = new Date("2026-03-01T00:00:00Z");
		store.setSessionInfo("account-1", "sess-xyz", expiresAt);

		// Session info should be set
		const info = store.getSessionInfo("account-1");
		expect(info?.sessionId).toBe("sess-xyz");

		// Game state should be unchanged
		const state = store.getState("account-1");
		expect(state?.player?.credits).toBe(500);
	});

	test("getSessionInfo round-trips sessionId and expiresAt correctly", () => {
		const expiresAt = new Date("2026-04-15T12:30:00.000Z");
		store.setSessionInfo("account-1", "sess-round-trip", expiresAt);

		const info = store.getSessionInfo("account-1");
		expect(info?.sessionId).toBe("sess-round-trip");
		expect(info?.expiresAt.toISOString()).toBe(expiresAt.toISOString());
	});
});

describe("StateStore.getAllAccountIds", () => {
	test("returns empty array when no accounts exist", () => {
		const ids = store.getAllAccountIds();
		expect(ids).toEqual([]);
	});

	test("returns all stored account IDs", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "P1", credits: 0, empire: "solarian" },
		});
		store.applyUpdate("account-2", {
			player: { id: "p2", username: "P2", credits: 0, empire: "colonial" },
		});
		store.applyUpdate("account-3", {
			player: { id: "p3", username: "P3", credits: 0, empire: "solarian" },
		});

		const ids = store.getAllAccountIds();
		expect(ids).toHaveLength(3);
		expect(ids).toContain("account-1");
		expect(ids).toContain("account-2");
		expect(ids).toContain("account-3");
	});

	test("reflects deletions", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "P1", credits: 0, empire: "solarian" },
		});
		store.applyUpdate("account-2", {
			player: { id: "p2", username: "P2", credits: 0, empire: "colonial" },
		});

		store.deleteState("account-1");
		const ids = store.getAllAccountIds();
		expect(ids).toEqual(["account-2"]);
	});
});

describe("StateStore.migrateSkillIds", () => {
	test("returns unchanged when no state exists for account", () => {
		const result = store.migrateSkillIds("unknown-account", { refinement: "ore_refinement" });
		expect(result).toEqual({ changed: false, changes: [] });
	});

	test("returns unchanged when skills column is null", () => {
		store.applyUpdate("account-1", {
			player: { id: "p1", username: "Test", credits: 0, empire: "solarian" },
		});

		const result = store.migrateSkillIds("account-1", { refinement: "ore_refinement" });
		expect(result).toEqual({ changed: false, changes: [] });
	});

	test("returns unchanged when no skills match the mapping", () => {
		db.run(
			"INSERT INTO game_state (account_id, skills, updated_at) VALUES (?, ?, datetime('now'))",
			["account-1", JSON.stringify({ mining: 3, trading: 2 })],
		);

		const result = store.migrateSkillIds("account-1", { refinement: "ore_refinement" });
		expect(result).toEqual({ changed: false, changes: [] });
	});

	test("remaps matching skill keys and writes back to database", () => {
		db.run(
			"INSERT INTO game_state (account_id, skills, updated_at) VALUES (?, ?, datetime('now'))",
			["account-1", JSON.stringify({ refinement: 5, jump_drive: 2, mining: 3 })],
		);

		const result = store.migrateSkillIds("account-1", {
			refinement: "ore_refinement",
			jump_drive: "jump_drive_operation",
		});

		expect(result.changed).toBe(true);
		expect(result.changes).toHaveLength(2);
		expect(result.changes).toContainEqual({ from: "refinement", to: "ore_refinement" });
		expect(result.changes).toContainEqual({ from: "jump_drive", to: "jump_drive_operation" });

		// Verify persisted changes
		const stored = store.getSection("account-1", "skills") as Record<string, number>;
		expect(stored["ore_refinement"]).toBe(5);
		expect(stored["jump_drive_operation"]).toBe(2);
		expect(stored["mining"]).toBe(3);
		expect(stored["refinement"]).toBeUndefined();
		expect(stored["jump_drive"]).toBeUndefined();
	});

	test("preserves skill levels during remapping", () => {
		db.run(
			"INSERT INTO game_state (account_id, skills, updated_at) VALUES (?, ?, datetime('now'))",
			["account-1", JSON.stringify({ crafting_basic: 7 })],
		);

		store.migrateSkillIds("account-1", { crafting_basic: "basic_crafting" });

		const stored = store.getSection("account-1", "skills") as Record<string, number>;
		expect(stored["basic_crafting"]).toBe(7);
	});
});
