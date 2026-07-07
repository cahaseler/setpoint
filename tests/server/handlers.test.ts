import { describe, expect, mock, test } from "bun:test";
import type { CraftingUpdateEnvelope, CraftingUpdateEvent } from "@setpoint/protocol";
import type { ClerkPlayer, GameState } from "@spacemolt/lib";
import { markStateFresh } from "../../src/dispatcher/state-freshness.js";
import {
	type HandlerContext,
	handleAbortAccount,
	handleAddAccount,
	handleCraftingEvents,
	handleDashboardData,
	handleDeleteAccount,
	handleExecuteGoal,
	handleExecuteGoalAsync,
	handleGetAccount,
	handleGetJob,
	handleGetLogLevel,
	handleGetLoop,
	handleGetMarket,
	handleGetObservation,
	handleGetState,
	handleGetStateSection,
	handleGetSystem,
	handleHealth,
	handleListAccounts,
	handleMigrateIds,
	handlePatchLoop,
	handleRawAction,
	handleRegisterAccount,
	handleSetLogLevel,
	handleStartLoop,
	handleStopLoop,
} from "../../src/server/handlers.js";
import { JobManager } from "../../src/server/job-manager.js";
import type { LoopManager, LoopStatus } from "../../src/server/loop-manager.js";
import { CraftingEventsStore } from "../../src/state/crafting-events-store.js";
import { createMemoryDatabase } from "../../src/state/database.js";
import type { StateStore } from "../../src/state/store.js";
import type { StoredGameState } from "../../src/state/store.js";
import {
	FakeLibManagedAccount,
	type FakeLibManagerOverrides,
	makeFakeLibManager,
} from "../dispatcher/lib-fakes.js";

// ── Mock Factories ───────────────────────────────────────────────────

function makeAccount(
	playerId: string,
	username = "TestPlayer",
	state?: GameState,
): FakeLibManagedAccount {
	return new FakeLibManagedAccount({
		playerId,
		username,
		...(state ? { state } : {}),
	});
}

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: undefined,
		ship: undefined,
		cargo: undefined,
		location: undefined,
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeContext(
	overrides: Partial<{
		accounts: FakeLibManagedAccount[];
		state: StoredGameState | null;
		loopStatus: LoopStatus | undefined;
		loopRunning: boolean;
		/** Owned-but-not-connected players returned by manager.listOwned(). */
		owned: ClerkPlayer[];
		/** Usernames/ids the manager reports as currently connecting. */
		connecting: string[];
	}> &
		FakeLibManagerOverrides = {},
): HandlerContext {
	const accounts = overrides.accounts ?? [];

	const managerOverrides: FakeLibManagerOverrides = {
		listOwned: overrides.listOwned ?? (() => Promise.resolve(overrides.owned ?? [])),
		isConnecting:
			overrides.isConnecting ??
			((idOrUsername: string) =>
				(overrides.connecting ?? []).some((u) => u.toLowerCase() === idOrUsername.toLowerCase())),
		...(overrides.connectOne ? { connectOne: overrides.connectOne } : {}),
		...(overrides.register ? { register: overrides.register } : {}),
		...(overrides.remove ? { remove: overrides.remove } : {}),
	};
	const manager = makeFakeLibManager(accounts, managerOverrides);

	const store = {
		getState: mock(() => overrides.state ?? null),
		getSection: mock((_id: string, section: string) => {
			const s = overrides.state;
			if (!s) return undefined;
			return s[section as keyof StoredGameState];
		}),
		getAllAccountIds: mock(() => []),
		migrateSkillIds: mock(() => ({ changed: false, changes: [] })),
	} as unknown as StateStore;

	const loopManager = {
		getStatus: mock(() => overrides.loopStatus),
		isRunning: mock(() => overrides.loopRunning ?? false),
		startMiningLoop: mock(() => ({
			type: "mining",
			startedAt: new Date().toISOString(),
			running: true,
		})),
		startEnhancedMiningLoop: mock(() => ({
			type: "enhanced-mining",
			startedAt: new Date().toISOString(),
			running: true,
		})),
		startSalvageLoop: mock(() => ({
			type: "salvage",
			startedAt: new Date().toISOString(),
			running: true,
		})),
		startTowSalvageLoop: mock(() => ({
			type: "tow-salvage",
			startedAt: new Date().toISOString(),
			running: true,
		})),
		startTradingLoop: mock(() => ({
			type: "trading",
			startedAt: new Date().toISOString(),
			running: true,
		})),
		startHaulingLoop: mock(() => ({
			type: "hauling",
			startedAt: new Date().toISOString(),
			running: true,
		})),
		startStorageTransferLoop: mock(() => ({
			type: "storage-transfer",
			startedAt: new Date().toISOString(),
			running: true,
		})),
		startExplorationLoop: mock(() => ({
			type: "exploration",
			startedAt: new Date().toISOString(),
			running: true,
		})),
		startGuardLoop: mock(() => ({
			type: "guard",
			startedAt: new Date().toISOString(),
			running: true,
		})),
		abortLoop: mock(() => overrides.loopRunning ?? false),
		forceRemove: mock(() => {}),
		getPromise: mock(() => (overrides.loopRunning ? Promise.resolve() : undefined)),
		getProgress: mock(() => undefined),
		patchLoopOptions: mock((_id: string, _patch: Record<string, unknown>) =>
			overrides.loopStatus ? { ...overrides.loopStatus, options: { patched: true } } : undefined,
		),
		saveLoopConfig: mock(() => Promise.resolve()),
		deleteLoopConfig: mock(() => Promise.resolve()),
		migrateLoopConfigs: mock(() => Promise.resolve([])),
	} as unknown as LoopManager;

	return {
		manager,
		store,
		loopManager,
		jobManager: new JobManager(createMemoryDatabase()),
		client: {} as HandlerContext["client"],
		configDir: "config",
		startedAt: "2026-01-01T00:00:00.000Z",
		executingGoals: new Map(),
		claimedAccounts: new Set(),
		craftingEventsStore: new CraftingEventsStore(),
	};
}

// ── Health ───────────────────────────────────────────────────────────

describe("handleHealth", () => {
	test("returns ok with uptime and account count", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const res = handleHealth(new Request("http://localhost/health"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["status"]).toBe("ok");
		expect(body["accounts"]).toBe(1);
		expect(typeof body["uptime"]).toBe("number");
		expect(body["startedAt"]).toBe("2026-01-01T00:00:00.000Z");
	});
});

// ── List Accounts ────────────────────────────────────────────────────

describe("handleListAccounts", () => {
	test("returns array of accounts with state and loop status", async () => {
		const account = makeAccount("p1", "Player1");
		const state = makeState({
			player: { id: "p1", username: "Player1", credits: 5000 },
			ship: {
				id: "s1",
				hull: 90,
				max_hull: 100,
				fuel: 45,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 25,
			},
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "sol_station",
				poi_name: "Sol Central",
				docked_at: "sol_base",
			},
		});
		const ctx = makeContext({ accounts: [account], state });

		const res = await handleListAccounts(new Request("http://localhost/accounts"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		const accounts = body["accounts"] as Array<Record<string, unknown>>;
		expect(accounts).toHaveLength(1);
		const first = accounts[0];
		expect(first).toBeDefined();
		expect(first?.["player_id"]).toBe("p1");
		expect(first?.["username"]).toBe("Player1");
		expect(first?.["credits"]).toBe(5000);
		const ship = first?.["ship"] as Record<string, unknown>;
		expect(ship["fuel"]).toBe(45);
		expect(ship["cargo_used"]).toBe(25);
		const location = first?.["location"] as Record<string, unknown>;
		expect(location["system"]).toBe("Sol");
		expect(location["docked"]).toBe("sol_base");
	});

	test("connected accounts have status connected", async () => {
		const account = makeAccount("p1", "Player1");
		const state = makeState({
			player: { id: "p1", username: "Player1", credits: 5000 },
		});
		const ctx = makeContext({ accounts: [account], state });

		const res = await handleListAccounts(new Request("http://localhost/accounts"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		const accounts = body["accounts"] as Array<Record<string, unknown>>;
		expect(accounts[0]?.["status"]).toBe("connected");
	});

	test("includes owned-but-not-connected accounts as disconnected", async () => {
		const owned: ClerkPlayer[] = [
			{ id: "cp1", username: "OwnedPlayer", empire: "solarian", hidden: false },
		];
		const ctx = makeContext({ owned });

		const res = await handleListAccounts(new Request("http://localhost/accounts"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		const accounts = body["accounts"] as Array<Record<string, unknown>>;
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.["username"]).toBe("OwnedPlayer");
		expect(accounts[0]?.["empire"]).toBe("solarian");
		expect(accounts[0]?.["status"]).toBe("disconnected");
		expect(accounts[0]?.["credits"]).toBeNull();
		expect(accounts[0]?.["ship"]).toBeNull();
		expect(accounts[0]?.["location"]).toBeNull();
		expect(accounts[0]?.["loop"]).toBeNull();
	});

	test("marks owned accounts with an in-flight connect as connecting", async () => {
		const owned: ClerkPlayer[] = [
			{ id: "cp1", username: "Booting", empire: "nebula", hidden: false },
		];
		const ctx = makeContext({ owned, connecting: ["Booting"] });

		const res = await handleListAccounts(new Request("http://localhost/accounts"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		const accounts = body["accounts"] as Array<Record<string, unknown>>;
		expect(accounts[0]?.["status"]).toBe("connecting");
	});

	test("excludes already-connected accounts from the owned list", async () => {
		const account = makeAccount("p1", "Player1");
		const owned: ClerkPlayer[] = [
			{ id: "cp1", username: "Player1", empire: "solarian", hidden: false },
		];
		const ctx = makeContext({ accounts: [account], owned });

		const res = await handleListAccounts(new Request("http://localhost/accounts"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		const accounts = body["accounts"] as Array<Record<string, unknown>>;
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.["status"]).toBe("connected");
	});

	test("degrades to connected-only when listOwned fails", async () => {
		const account = makeAccount("p1", "Player1");
		const ctx = makeContext({
			accounts: [account],
			listOwned: () => Promise.reject(new Error("Clerk unavailable")),
		});

		const res = await handleListAccounts(new Request("http://localhost/accounts"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		const accounts = body["accounts"] as Array<Record<string, unknown>>;
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.["status"]).toBe("connected");
	});

	test("returns empty array when no accounts", async () => {
		const ctx = makeContext();

		const res = await handleListAccounts(new Request("http://localhost/accounts"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		const accounts = body["accounts"] as unknown[];
		expect(accounts).toHaveLength(0);
	});
});

// ── Get Account ──────────────────────────────────────────────────────

describe("handleGetAccount", () => {
	test("returns account details with state summary", async () => {
		const account = makeAccount("p1");
		const state = makeState({
			player: { credits: 500 } as StoredGameState["player"],
			ship: { hull: 80, max_hull: 100, fuel: 50, max_fuel: 100 } as StoredGameState["ship"],
			location: { system_name: "Sol", poi_name: "Station Alpha" } as StoredGameState["location"],
		});
		const ctx = makeContext({ accounts: [account], state });

		const res = handleGetAccount(
			new Request("http://localhost/accounts/p1"),
			{ playerId: "p1" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["player_id"]).toBe("p1");

		const stateBody = body["state"] as Record<string, unknown>;
		expect(stateBody["credits"]).toBe(500);

		// Verify dispatcher status fields are present
		expect(body["hasRunningJob"]).toBe(false);
		expect(body["runningJob"]).toBeNull();
		expect(body["hasExecutingGoal"]).toBe(false);
		expect(body["executingGoal"]).toBeNull();
		expect(body["recentJobs"]).toEqual([]);
	});

	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();

		const res = handleGetAccount(
			new Request("http://localhost/accounts/nope"),
			{ playerId: "nope" },
			ctx,
		);
		expect(res.status).toBe(404);
	});

	test("returns 400 when playerId missing", async () => {
		const ctx = makeContext();

		const res = handleGetAccount(new Request("http://localhost/accounts/"), {}, ctx);
		expect(res.status).toBe(400);
	});
});

// ── Add Account ──────────────────────────────────────────────────────

describe("handleAddAccount", () => {
	test("starts a background connect for an owned account and returns 202", async () => {
		const ctx = makeContext({
			connectOne: () => Promise.resolve(makeAccount("p-new", "OwnedPlayer")),
		});

		const req = new Request("http://localhost/accounts", {
			method: "POST",
			body: JSON.stringify({ username: "OwnedPlayer" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleAddAccount(req, {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(202);
		expect(body["username"]).toBe("OwnedPlayer");
		expect(body["status"]).toBe("connecting");
	});

	test("returns 400 for invalid JSON body", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/accounts", {
			method: "POST",
			body: "not json",
		});

		const res = await handleAddAccount(req, {}, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 when username is missing", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/accounts", {
			method: "POST",
			body: JSON.stringify({ password: "secret" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleAddAccount(req, {}, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 409 when the account is already connected", async () => {
		const account = makeAccount("p1", "Existing");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts", {
			method: "POST",
			body: JSON.stringify({ username: "Existing" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleAddAccount(req, {}, ctx);
		expect(res.status).toBe(409);
	});
});

// ── Delete Account ───────────────────────────────────────────────────

describe("handleDeleteAccount", () => {
	test("disconnects account and returns success", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const res = await handleDeleteAccount(
			new Request("http://localhost/accounts/p1", { method: "DELETE" }),
			{ playerId: "p1" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["message"]).toBe("Account disconnected");
		expect(body["player_id"]).toBe("p1");
	});

	test("stops running loop before disconnecting", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account], loopRunning: true });

		const res = await handleDeleteAccount(
			new Request("http://localhost/accounts/p1", { method: "DELETE" }),
			{ playerId: "p1" },
			ctx,
		);
		expect(res.status).toBe(200);
		expect(ctx.loopManager.abortLoop).toHaveBeenCalledWith("p1");
	});

	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();

		const res = await handleDeleteAccount(
			new Request("http://localhost/accounts/nope", { method: "DELETE" }),
			{ playerId: "nope" },
			ctx,
		);
		expect(res.status).toBe(404);
	});
});

// ── Get State ────────────────────────────────────────────────────────

describe("handleGetState", () => {
	test("returns full state for account", async () => {
		const account = makeAccount("p1");
		const state = makeState({ player: { credits: 100 } as StoredGameState["player"] });
		const ctx = makeContext({ accounts: [account], state });

		const res = handleGetState(
			new Request("http://localhost/accounts/p1/state"),
			{ playerId: "p1" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect((body["player"] as Record<string, unknown>)["credits"]).toBe(100);
	});

	test("returns 404 when no state available", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account], state: null });

		const res = handleGetState(
			new Request("http://localhost/accounts/p1/state"),
			{ playerId: "p1" },
			ctx,
		);
		expect(res.status).toBe(404);
	});

	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();

		const res = handleGetState(
			new Request("http://localhost/accounts/unknown/state"),
			{ playerId: "unknown" },
			ctx,
		);
		expect(res.status).toBe(404);
	});
});

// ── Get State Section ────────────────────────────────────────────────

describe("handleGetStateSection", () => {
	test("returns individual section", async () => {
		const account = makeAccount("p1");
		const state = makeState({
			ship: { hull: 80, max_hull: 100 } as StoredGameState["ship"],
		});
		const ctx = makeContext({ accounts: [account], state });

		const res = handleGetStateSection(
			new Request("http://localhost/accounts/p1/state/ship"),
			{ playerId: "p1", section: "ship" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["hull"]).toBe(80);
	});

	test("returns 400 for invalid section", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const res = handleGetStateSection(
			new Request("http://localhost/accounts/p1/state/invalid"),
			{ playerId: "p1", section: "invalid" },
			ctx,
		);
		expect(res.status).toBe(400);
	});

	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();

		const res = handleGetStateSection(
			new Request("http://localhost/accounts/unknown/state/ship"),
			{ playerId: "unknown", section: "ship" },
			ctx,
		);
		expect(res.status).toBe(404);
	});

	test("returns 404 when section data is undefined", async () => {
		const account = makeAccount("p1");
		const state = makeState(); // all sections undefined
		const ctx = makeContext({ accounts: [account], state });

		const res = handleGetStateSection(
			new Request("http://localhost/accounts/p1/state/ship"),
			{ playerId: "p1", section: "ship" },
			ctx,
		);
		expect(res.status).toBe(404);
	});
});

// ── Get Loop ─────────────────────────────────────────────────────────

describe("handleGetLoop", () => {
	test("returns loop status when running", async () => {
		const account = makeAccount("p1");
		const loopStatus: LoopStatus = {
			type: "mining",
			startedAt: "2026-01-01T00:00:00.000Z",
			running: true,
		};
		const ctx = makeContext({ accounts: [account], loopStatus });

		const res = handleGetLoop(
			new Request("http://localhost/accounts/p1/loop"),
			{ playerId: "p1" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["type"]).toBe("mining");
		expect(body["running"]).toBe(true);
	});

	test("returns running: false when no loop", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const res = handleGetLoop(
			new Request("http://localhost/accounts/p1/loop"),
			{ playerId: "p1" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["running"]).toBe(false);
	});

	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();

		const res = handleGetLoop(
			new Request("http://localhost/accounts/unknown/loop"),
			{ playerId: "unknown" },
			ctx,
		);
		expect(res.status).toBe(404);
	});
});

// ── Patch Loop ───────────────────────────────────────────────────────

describe("handlePatchLoop", () => {
	test("patches loop options on running loop and returns 200 with updated status", async () => {
		const account = makeAccount("p1");
		const loopStatus: LoopStatus = {
			type: "enhanced-mining",
			startedAt: "2026-01-01T00:00:00.000Z",
			running: true,
			options: { junkItemIds: ["rock_dust"] },
		};
		const ctx = makeContext({ accounts: [account], loopStatus });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ junkItemIds: ["rock_dust", "metal_fragment"] }),
		});
		const res = await handlePatchLoop(req, { playerId: "p1" }, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["running"]).toBe(true);
	});

	test("returns 409 when no loop is running", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ junkItemIds: [] }),
		});
		const res = await handlePatchLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(409);
	});

	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/accounts/unknown/loop", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ junkItemIds: [] }),
		});
		const res = await handlePatchLoop(req, { playerId: "unknown" }, ctx);
		expect(res.status).toBe(404);
	});

	test("returns 400 for empty patch", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		const res = await handlePatchLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 when patch is nested under an options wrapper", async () => {
		const account = makeAccount("p1");
		const loopStatus: LoopStatus = {
			type: "enhanced-mining",
			startedAt: "2026-01-01T00:00:00.000Z",
			running: true,
			options: { junkItemIds: ["rock_dust"] },
		};
		const ctx = makeContext({ accounts: [account], loopStatus });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ options: { junkItemIds: ["rock_dust"] } }),
		});
		const res = await handlePatchLoop(req, { playerId: "p1" }, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(400);
		expect(body["error"]).toContain('"options"');
		expect(body["error"]).toContain("top level");
	});

	test("returns 400 listing valid keys for an unknown option key", async () => {
		const account = makeAccount("p1");
		const loopStatus: LoopStatus = {
			type: "enhanced-mining",
			startedAt: "2026-01-01T00:00:00.000Z",
			running: true,
			options: { junkItemIds: ["rock_dust"] },
		};
		const ctx = makeContext({ accounts: [account], loopStatus });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ junkItmIds: ["rock_dust"] }),
		});
		const res = await handlePatchLoop(req, { playerId: "p1" }, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(400);
		expect(body["error"]).toContain("junkItmIds");
		expect(body["error"]).toContain("junkItemIds");
	});

	test("allows patching a loop type with no schema entry", async () => {
		const account = makeAccount("p1");
		const loopStatus: LoopStatus = {
			type: "experimental-loop",
			startedAt: "2026-01-01T00:00:00.000Z",
			running: true,
			options: {},
		};
		const ctx = makeContext({ accounts: [account], loopStatus });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ anything: true }),
		});
		const res = await handlePatchLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200);
	});

	test("returns 400 for a wrong-typed patch field value", async () => {
		const account = makeAccount("p1");
		const loopStatus: LoopStatus = {
			type: "enhanced-mining",
			startedAt: "2026-01-01T00:00:00.000Z",
			running: true,
			options: { junkItemIds: ["rock_dust"] },
		};
		const ctx = makeContext({ accounts: [account], loopStatus });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ junkItemIds: "not-an-array" }),
		});
		const res = await handlePatchLoop(req, { playerId: "p1" }, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(400);
		expect(body["error"]).toContain("junkItemIds");
	});
});

// ── Start Loop ───────────────────────────────────────────────────────

describe("handleStartLoop", () => {
	test("starts mining loop and returns 201", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "mining",
				options: {
					miningSystemId: "sys-1",
					beltPoiId: "belt-1",
					sellSystemId: "sys-2",
					sellStationPoiId: "station-1",
					sellBaseId: "base-1",
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["type"]).toBe("mining");
		expect(body["running"]).toBe(true);
	});

	test("returns 400 for invalid JSON", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: "not json",
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for unknown loop type", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({ type: "combat", options: {} }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for missing required mining options", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "mining",
				options: { miningSystemId: "sys-1" },
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/accounts/unknown/loop", {
			method: "POST",
			body: JSON.stringify({ type: "mining", options: {} }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "unknown" }, ctx);
		expect(res.status).toBe(404);
	});

	test("returns 400 for non-object body", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify([1, 2, 3]),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for non-object options", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({ type: "mining", options: "not an object" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("passes optional mining options when provided", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "mining",
				options: {
					miningSystemId: "sys-1",
					beltPoiId: "belt-1",
					sellSystemId: "sys-2",
					sellStationPoiId: "station-1",
					sellBaseId: "base-1",
					fullThreshold: 0.8,
					maxAttempts: 50,
					maxIterations: 10,
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);
	});

	test("passes depositTarget to startMiningLoop", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "mining",
				options: {
					miningSystemId: "sys-1",
					beltPoiId: "belt-1",
					sellSystemId: "sys-2",
					sellStationPoiId: "station-1",
					sellBaseId: "base-1",
					depositTarget: "faction",
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);

		const calls = (ctx.loopManager.startMiningLoop as ReturnType<typeof mock>).mock.calls;
		const opts = calls[0]?.[1] as Record<string, unknown>;
		expect(opts["depositTarget"]).toBe("faction");
	});

	test("passes cashSource faction and minCredits to startMiningLoop", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "mining",
				options: {
					miningSystemId: "sys-1",
					beltPoiId: "belt-1",
					sellSystemId: "sys-2",
					sellStationPoiId: "station-1",
					sellBaseId: "base-1",
					cashSource: "faction",
					minCredits: 2000,
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);

		const calls = (ctx.loopManager.startMiningLoop as ReturnType<typeof mock>).mock.calls;
		const opts = calls[0]?.[1] as Record<string, unknown>;
		expect(opts["cashSource"]).toBe("faction");
		expect(opts["minCredits"]).toBe(2000);
	});

	test("rejects cashSource personal (only faction is valid)", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "mining",
				options: {
					miningSystemId: "sys-1",
					beltPoiId: "belt-1",
					sellSystemId: "sys-2",
					sellStationPoiId: "station-1",
					sellBaseId: "base-1",
					cashSource: "personal",
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["error"]).toContain("cashSource");
	});

	test("returns 400 with a zod-formatted message for a missing required mining option", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "mining",
				options: {
					beltPoiId: "belt-1",
					sellSystemId: "sys-2",
					sellStationPoiId: "station-1",
					sellBaseId: "base-1",
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["error"]).toBe("options.miningSystemId: Required");
	});

	test("starts salvage loop with required options", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "salvage",
				options: {
					salvageSystemId: "sol",
					salvagePoiId: "belt-1",
					sellSystemId: "sol",
					sellStationPoiId: "sol-station",
					sellBaseId: "sol-base",
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);

		const calls = (ctx.loopManager.startSalvageLoop as ReturnType<typeof mock>).mock.calls;
		const opts = calls[0]?.[1] as Record<string, unknown>;
		expect(opts["salvageSystemId"]).toBe("sol");
		expect(opts["salvagePoiId"]).toBe("belt-1");
		expect(opts["sellBaseId"]).toBe("sol-base");
	});

	test("returns 400 for missing required salvage options", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "salvage",
				options: { salvageSystemId: "sol" },
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("starts tow-salvage loop and returns 201", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "tow-salvage",
				options: {
					mode: "fixed",
					disposition: "scrap",
					yardSystemId: "sol",
					yardPoiId: "yard",
					yardBaseId: "yard-base",
					wreckSystemId: "sol",
					wreckPoiId: "belt",
				},
			}),
		});
		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);
		const opts = (ctx.loopManager.startTowSalvageLoop as ReturnType<typeof mock>).mock
			.calls[0]?.[1] as Record<string, unknown>;
		expect(opts["wreckPoiId"]).toBe("belt");
		expect(opts["yardBaseId"]).toBe("yard-base");
	});

	test("returns 400 for tow-salvage fixed mode missing wreckPoiId", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "tow-salvage",
				options: {
					mode: "fixed",
					yardSystemId: "sol",
					yardPoiId: "yard",
					yardBaseId: "yard-base",
					wreckSystemId: "sol",
				},
			}),
		});
		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("starts enhanced-mining loop with required options", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "enhanced-mining",
				options: {
					miningSystemId: "sol",
					beltPoiId: "belt-1",
					sellSystemId: "sol",
					sellStationPoiId: "sol-station",
					sellBaseId: "sol-base",
					junkItemIds: ["debris", "rock"],
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);

		const calls = (ctx.loopManager.startEnhancedMiningLoop as ReturnType<typeof mock>).mock.calls;
		const opts = calls[0]?.[1] as Record<string, unknown>;
		expect(opts["junkItemIds"]).toEqual(["debris", "rock"]);
	});

	test("returns 400 for enhanced-mining missing junkItemIds", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "enhanced-mining",
				options: {
					miningSystemId: "sol",
					beltPoiId: "belt-1",
					sellSystemId: "sol",
					sellStationPoiId: "sol-station",
					sellBaseId: "sol-base",
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("starts trading loop with required options", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "trading",
				options: {
					buyStation: { systemId: "sol", poiId: "buy-station", baseId: "buy-base" },
					sellStation: { systemId: "sol", stationPoiId: "sell-station", baseId: "sell-base" },
					items: [{ itemId: "iron_ore", maxBuyPrice: 10, minSellPrice: 20 }],
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);

		const calls = (ctx.loopManager.startTradingLoop as ReturnType<typeof mock>).mock.calls;
		const opts = calls[0]?.[1] as Record<string, unknown>;
		const buyStation = opts["buyStation"] as Record<string, unknown>;
		expect(buyStation["baseId"]).toBe("buy-base");
	});

	test("returns 400 for trading with missing items array", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "trading",
				options: {
					buyStation: { systemId: "sol", poiId: "buy-station", baseId: "buy-base" },
					sellStation: { systemId: "sol", stationPoiId: "sell-station", baseId: "sell-base" },
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("starts hauling loop with required options", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "hauling",
				options: {
					source: {
						systemId: "sol",
						poiId: "src-station",
						baseId: "src-base",
						type: "personal-storage",
						items: [{ itemId: "iron_ore" }],
					},
					destination: {
						systemId: "sol",
						poiId: "dst-station",
						baseId: "dst-base",
						type: "faction-storage",
					},
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);

		const calls = (ctx.loopManager.startHaulingLoop as ReturnType<typeof mock>).mock.calls;
		const opts = calls[0]?.[1] as Record<string, unknown>;
		const source = opts["source"] as Record<string, unknown>;
		expect(source["type"]).toBe("personal-storage");
	});

	test("returns 400 for hauling with invalid source type", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "hauling",
				options: {
					source: {
						systemId: "sol",
						poiId: "src-station",
						baseId: "src-base",
						type: "invalid-type",
						items: [{ itemId: "iron_ore" }],
					},
					destination: {
						systemId: "sol",
						poiId: "dst-station",
						baseId: "dst-base",
						type: "faction-storage",
					},
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for hauling gift type without targetPlayer", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "hauling",
				options: {
					source: {
						systemId: "sol",
						poiId: "src-station",
						baseId: "src-base",
						type: "personal-storage",
						items: [{ itemId: "iron_ore" }],
					},
					destination: {
						systemId: "sol",
						poiId: "dst-station",
						baseId: "dst-base",
						type: "gift",
					},
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("starts storage-transfer loop with required options", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "storage-transfer",
				options: {
					systemId: "sol",
					stationPoiId: "sol-station",
					baseId: "sol-base",
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);

		const calls = (ctx.loopManager.startStorageTransferLoop as ReturnType<typeof mock>).mock.calls;
		const opts = calls[0]?.[1] as Record<string, unknown>;
		expect(opts["systemId"]).toBe("sol");
	});

	test("returns 400 for storage-transfer with missing systemId", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "storage-transfer",
				options: { stationPoiId: "sol-station", baseId: "sol-base" },
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("starts exploration loop with required options", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "exploration",
				options: {
					systemId: "sol",
					stationPoiId: "sol-station",
					baseId: "sol-base",
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);

		const calls = (ctx.loopManager.startExplorationLoop as ReturnType<typeof mock>).mock.calls;
		const opts = calls[0]?.[1] as Record<string, unknown>;
		expect(opts["baseId"]).toBe("sol-base");
	});

	test("returns 400 for exploration with missing baseId", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "exploration",
				options: { systemId: "sol", stationPoiId: "sol-station" },
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("starts guard loop with required options", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "guard",
				options: {
					homeSystemId: "sol",
					homeStationPoiId: "sol-station",
					homeBaseId: "sol-base",
					guardSystemId: "frontier",
					guardPoiId: "belt-1",
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);

		const calls = (ctx.loopManager.startGuardLoop as ReturnType<typeof mock>).mock.calls;
		const opts = calls[0]?.[1] as Record<string, unknown>;
		expect(opts["guardPoiId"]).toBe("belt-1");
	});

	test("returns 400 for guard with missing guardPoiId", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "guard",
				options: {
					homeSystemId: "sol",
					homeStationPoiId: "sol-station",
					homeBaseId: "sol-base",
					guardSystemId: "frontier",
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 410 deprecated for the removed crafting loop", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "crafting",
				options: {
					systemId: "sol",
					stationPoiId: "sol-station",
					baseId: "sol-base",
					recipeId: "iron_bar",
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(410);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("DEPRECATED");
		expect(body.error).toContain("raw");
	});

	test("stops existing loop before starting new one", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account], loopRunning: true });

		const req = new Request("http://localhost/accounts/p1/loop", {
			method: "POST",
			body: JSON.stringify({
				type: "mining",
				options: {
					miningSystemId: "sol",
					beltPoiId: "belt-1",
					sellSystemId: "sol",
					sellStationPoiId: "sol-station",
					sellBaseId: "sol-base",
				},
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleStartLoop(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(201);
		expect(ctx.loopManager.forceRemove).toHaveBeenCalledWith("p1");
		expect(ctx.loopManager.deleteLoopConfig).toHaveBeenCalledWith("p1", "config");
	});
});

// ── Stop Loop ────────────────────────────────────────────────────────

describe("handleStopLoop", () => {
	test("stops running loop and returns success", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account], loopRunning: true });

		const res = await handleStopLoop(
			new Request("http://localhost/accounts/p1/loop", { method: "DELETE" }),
			{ playerId: "p1" },
			ctx,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["message"]).toBe("Loop stop signal sent");
		expect(ctx.loopManager.abortLoop).toHaveBeenCalledWith("p1");
		expect(ctx.loopManager.deleteLoopConfig).toHaveBeenCalledWith("p1", "config");
	});

	test("returns 404 when no loop running", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account], loopRunning: false });

		const res = await handleStopLoop(
			new Request("http://localhost/accounts/p1/loop", { method: "DELETE" }),
			{ playerId: "p1" },
			ctx,
		);
		expect(res.status).toBe(404);
	});

	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();

		const res = await handleStopLoop(
			new Request("http://localhost/accounts/unknown/loop", { method: "DELETE" }),
			{ playerId: "unknown" },
			ctx,
		);
		expect(res.status).toBe(404);
	});

	test("resolves account by username", async () => {
		const account = makeAccount("p1", "TestPlayer");
		const ctx = makeContext({ accounts: [account], loopRunning: true });

		const res = await handleStopLoop(
			new Request("http://localhost/accounts/TestPlayer/loop", { method: "DELETE" }),
			{ playerId: "TestPlayer" },
			ctx,
		);
		expect(res.status).toBe(200);
		expect(ctx.loopManager.abortLoop).toHaveBeenCalledWith("p1");
	});
});

// ── Register Account ─────────────────────────────────────────────────

describe("handleRegisterAccount", () => {
	test("returns 400 for invalid JSON body", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/accounts/register", {
			method: "POST",
			body: "not json",
		});

		const res = await handleRegisterAccount(req, {}, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for non-object body", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/accounts/register", {
			method: "POST",
			body: JSON.stringify("string-body"),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRegisterAccount(req, {}, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for missing username", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/accounts/register", {
			method: "POST",
			body: JSON.stringify({ empire: "solarian" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRegisterAccount(req, {}, ctx);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["error"] as string).toContain("username");
	});

	test("returns 400 for username too short", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/accounts/register", {
			method: "POST",
			body: JSON.stringify({ username: "ab", empire: "solarian" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRegisterAccount(req, {}, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for invalid empire", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/accounts/register", {
			method: "POST",
			body: JSON.stringify({ username: "NewPlayer", empire: "invalid_faction" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRegisterAccount(req, {}, ctx);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["error"] as string).toContain("empire");
	});

	test("returns 409 for duplicate username", async () => {
		const account = makeAccount("p1", "ExistingPlayer");
		const ctx = makeContext({ accounts: [account] });

		const req = new Request("http://localhost/accounts/register", {
			method: "POST",
			body: JSON.stringify({ username: "ExistingPlayer", empire: "solarian" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRegisterAccount(req, {}, ctx);
		expect(res.status).toBe(409);
	});

	test("returns 500 when registration config cannot be loaded", async () => {
		const ctx = makeContext();
		// configDir points to a nonexistent directory
		ctx.configDir = "/nonexistent/path/that/does/not/exist";

		const req = new Request("http://localhost/accounts/register", {
			method: "POST",
			body: JSON.stringify({ username: "NewPlayer", empire: "solarian" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRegisterAccount(req, {}, ctx);
		expect(res.status).toBe(500);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["error"] as string).toContain("Failed to load registration config");
	});
});

// ── Abort ─────────────────────────────────────────────────────────────

describe("handleAbortAccount", () => {
	test("force mode aborts loop, clears running job, clears sync goal", async () => {
		const account = makeAccount("p1");
		const loopStatus: LoopStatus = {
			type: "mining",
			startedAt: "2026-01-01T00:00:00.000Z",
			running: true,
		};
		const ctx = makeContext({ accounts: [account], loopRunning: true, loopStatus });

		// Plant a running job and a sync goal
		ctx.jobManager.create("p1", "navigate-to-system", {});
		ctx.executingGoals.set("p1", {
			goalType: "test-goal",
			startedAt: new Date().toISOString(),
			controller: new AbortController(),
			progress: { goalType: "test-goal", completedSteps: [], remainingSteps: [] },
			promise: Promise.resolve(),
		});

		const req = new Request("http://localhost/accounts/p1/abort", {
			method: "DELETE",
			body: JSON.stringify({ force: true }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleAbortAccount(req, { playerId: "p1" }, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["message"]).toContain("aborted");
		expect(ctx.loopManager.forceRemove).toHaveBeenCalledWith("p1");
		expect(ctx.executingGoals.has("p1")).toBe(false);
	});

	test("default mode returns status when account has in-progress work", async () => {
		const account = makeAccount("p1");
		const loopStatus: LoopStatus = {
			type: "mining",
			startedAt: "2026-01-01T00:00:00.000Z",
			running: true,
		};
		const ctx = makeContext({ accounts: [account], loopRunning: true, loopStatus });

		const req = new Request("http://localhost/accounts/p1/abort", {
			method: "DELETE",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleAbortAccount(req, { playerId: "p1" }, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		// Default mode reports status, does not abort
		expect(body["message"]).toBeDefined();
	});

	test("returns idle message when account has no in-progress work", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account], loopRunning: false });

		const req = new Request("http://localhost/accounts/p1/abort", {
			method: "DELETE",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleAbortAccount(req, { playerId: "p1" }, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["message"]).toContain("idle");
	});

	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/accounts/unknown/abort", {
			method: "DELETE",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleAbortAccount(req, { playerId: "unknown" }, ctx);
		expect(res.status).toBe(404);
	});
});

// ── Log Level ────────────────────────────────────────────────────────

describe("handleGetLogLevel", () => {
	test("returns current log level", async () => {
		const ctx = makeContext();

		const res = handleGetLogLevel(new Request("http://localhost/log-level"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(typeof body["level"]).toBe("string");
	});
});

describe("handleSetLogLevel", () => {
	test("sets log level and returns previous", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/log-level", {
			method: "POST",
			body: JSON.stringify({ level: "debug" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleSetLogLevel(req, {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["level"]).toBe("debug");
		expect(typeof body["previous"]).toBe("string");
	});

	test("returns 400 for invalid level", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/log-level", {
			method: "POST",
			body: JSON.stringify({ level: "verbose" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleSetLogLevel(req, {}, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for invalid JSON", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/log-level", {
			method: "POST",
			body: "not json",
		});

		const res = await handleSetLogLevel(req, {}, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for non-object body", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/log-level", {
			method: "POST",
			body: JSON.stringify("debug"),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleSetLogLevel(req, {}, ctx);
		expect(res.status).toBe(400);
	});
});

// ── Execute Goal ────────────────────────────────────────────────────

describe("handleExecuteGoal", () => {
	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();
		const req = new Request("http://localhost/accounts/unknown/goal", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoal(req, { playerId: "unknown" }, ctx);
		expect(res.status).toBe(404);
	});

	test("returns 409 when loop is running", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account], loopRunning: true });
		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(409);
	});

	test("returns 400 for unknown goal type", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: JSON.stringify({ type: "nonexistent-goal" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["error"] as string).toContain("Unknown goal type");
	});

	test("returns 410 deprecated for the removed craft goal", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: JSON.stringify({ type: "craft", options: { recipeId: "iron_bar" } }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(410);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["error"] as string).toContain("DEPRECATED");
		expect(body["error"] as string).toContain("raw");
	});

	test("returns 400 for missing goal type", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: JSON.stringify({}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("rejects one of two concurrent sync submissions for the same account", async () => {
		// Regression: see the equivalent handleExecuteGoalAsync test — the same
		// race existed here, since executingGoals.set() also happened only
		// after several awaits past the initial "is anything running" checks.
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const makeReq = () =>
			new Request("http://localhost/accounts/p1/goal", {
				method: "POST",
				body: JSON.stringify({ type: "ensure-undocked" }),
				headers: { "Content-Type": "application/json" },
			});

		const [resA, resB] = await Promise.all([
			handleExecuteGoal(makeReq(), { playerId: "p1" }, ctx),
			handleExecuteGoal(makeReq(), { playerId: "p1" }, ctx),
		]);

		const statuses = [resA.status, resB.status].sort();
		expect(statuses).toEqual([200, 409]);
	});

	test("returns 400 for invalid JSON body", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: "not json",
		});

		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for missing required options", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: JSON.stringify({ type: "navigate-to-system", options: {} }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		// Validated via the @setpoint/protocol zod schema — the goal-registry
		// formats the ZodError into a readable "options.<field>: <message>" string.
		expect(body["error"] as string).toBe("options.targetSystemId: Required");
	});

	test("returns 409 immediately when a sync goal is already executing for this account", async () => {
		// The dispatcher's original behavior was to reject outright when a goal
		// or loop was already in progress, not queue behind it. A queuing
		// window here is exactly what let two overlapping goal executions run
		// concurrently against the same ship.
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		ctx.executingGoals.set("p1", {
			goalType: "test-goal",
			startedAt: new Date().toISOString(),
			controller: new AbortController(),
			progress: { goalType: "test-goal", completedSteps: [], remainingSteps: [] },
			promise: Promise.resolve(),
		});

		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(409);
	});

	test("client disconnect signals the goal to abort but keeps the executingGoals lock until it actually settles", async () => {
		let releaseFindRoute: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseFindRoute = resolve;
		});
		const account = new FakeLibManagedAccount({
			playerId: "p1",
			username: "TestPlayer",
			state: { location: { system_id: "sol", poi_id: "p" } },
			handlers: {
				find_route: async () => {
					await gate;
					return {
						result: "",
						structuredContent: {
							cargo_used: 0,
							estimated_fuel: 0,
							found: true,
							fuel_available: 1000,
							fuel_per_jump: 0,
							message: "",
							route: [],
							target_system: "alpha",
							total_jumps: 0,
						},
					};
				},
			},
		});
		const ctx = makeContext({ accounts: [account] });

		const abortController = new AbortController();
		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: JSON.stringify({ type: "navigate-to-system", options: { targetSystemId: "alpha" } }),
			headers: { "Content-Type": "application/json" },
			signal: abortController.signal,
		});

		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200);

		const executing = ctx.executingGoals.get("p1");
		expect(executing).toBeDefined();
		const goalPromise = executing?.promise;

		// Simulate the client disconnecting while find_route is still pending.
		abortController.abort();
		await Promise.resolve();
		await Promise.resolve();

		// The goal's own controller must be signaled...
		expect(executing?.controller.signal.aborted).toBe(true);
		// ...but the lock must NOT be cleared just because the client left —
		// a fresh submission racing this still-running goal is the bug this fixes.
		expect(ctx.executingGoals.has("p1")).toBe(true);

		// Let find_route resolve; navigate-to-system's own signal check then
		// stops it at the top of the hop loop.
		releaseFindRoute?.();
		await goalPromise;
		await Promise.resolve();

		expect(ctx.executingGoals.has("p1")).toBe(false);
	});

	test("returns 409 when an async job is running for this account", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		ctx.jobManager.create("p1");

		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(409);
	});

	test("clears executingGoals lock after goal completes (even on error)", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		expect(ctx.executingGoals.has("p1")).toBe(false);

		// Use a goal that gets past validation but throws during execute (endpoint not mocked)
		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		// Streaming response: handler returns immediately; drain body to wait for the
		// async .catch() callback that clears the lock after goal throws.
		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		await res.text(); // wait for goal to throw and lock to be cleared

		// Lock must be cleared regardless of outcome
		expect(ctx.executingGoals.has("p1")).toBe(false);
	});

	test("refreshes state before executing when the cache is stale", async () => {
		const account = makeAccount("p1");
		markStateFresh(account, Date.now() - 1_000_000); // long past the freshness TTL
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200);
		await res.text(); // drain to let the goal (and its own post-completion refresh) finish
		// 2 = 1 pre-execute refresh (stale cache) + 1 unconditional post-completion refresh.
		expect(account.refreshCalls).toBe(2);
	});

	test("does not refresh state before executing when the cache is fresh", async () => {
		const account = makeAccount("p1");
		markStateFresh(account); // just marked — well within the TTL
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200);
		await res.text(); // drain to let the goal (and its own post-completion refresh) finish
		// 1 = 0 pre-execute refresh (fresh cache, skipped) + 1 unconditional post-completion refresh.
		expect(account.refreshCalls).toBe(1);
	});
});

// ── Execute Goal Async ───────────────────────────────────────────────

describe("handleExecuteGoalAsync", () => {
	test("returns 202 with job_id for valid goal", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal/async", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoalAsync(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(202);
		const body = (await res.json()) as Record<string, unknown>;
		expect(typeof body["job_id"]).toBe("string");
		expect((body["job_id"] as string).length).toBeGreaterThan(0);
	});

	test("stores goal options in the job record for resumption", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal/async", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked", options: { someFlag: true } }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoalAsync(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(202);
		const body = (await res.json()) as Record<string, unknown>;
		const jobId = body["job_id"] as string;

		const job = ctx.jobManager.get(jobId);
		expect(job?.goalType).toBe("ensure-undocked");
		expect(job?.goalOptions).toEqual({ someFlag: true });
	});

	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();
		const req = new Request("http://localhost/accounts/unknown/goal/async", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoalAsync(req, { playerId: "unknown" }, ctx);
		expect(res.status).toBe(404);
	});

	test("returns 409 when loop is running", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account], loopRunning: true });
		const req = new Request("http://localhost/accounts/p1/goal/async", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoalAsync(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(409);
	});

	test("returns 409 when async job already running for account", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		// Manually create a running job for p1
		ctx.jobManager.create("p1");

		const req = new Request("http://localhost/accounts/p1/goal/async", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoalAsync(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(409);
	});

	test("returns 400 for unknown goal type", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal/async", {
			method: "POST",
			body: JSON.stringify({ type: "nonexistent-goal" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoalAsync(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 with a validation message for missing required options", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal/async", {
			method: "POST",
			body: JSON.stringify({ type: "navigate-to-system", options: {} }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoalAsync(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["error"] as string).toBe("options.targetSystemId: Required");
	});

	test("returns 410 deprecated for the removed craft goal", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal/async", {
			method: "POST",
			body: JSON.stringify({ type: "craft", options: { recipeId: "iron_bar" } }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoalAsync(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(410);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["error"] as string).toContain("DEPRECATED");
	});

	test("returns 409 when a sync goal is already executing for this account", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		ctx.executingGoals.set("p1", {
			goalType: "test-goal",
			startedAt: new Date().toISOString(),
			controller: new AbortController(),
			progress: { goalType: "test-goal", completedSteps: [], remainingSteps: [] },
			promise: Promise.resolve(),
		});

		const req = new Request("http://localhost/accounts/p1/goal/async", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoalAsync(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(409);
	});

	test("refreshes state before executing when the cache is stale", async () => {
		const account = makeAccount("p1");
		markStateFresh(account, Date.now() - 1_000_000); // long past the freshness TTL
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal/async", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoalAsync(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(202);
		// 2 = 1 pre-execute refresh (stale cache) + 1 unconditional post-completion refresh
		// (the fake job's goal.execute()/.then() chain settles via microtasks before this
		// await resolves, same as the sync handler).
		expect(account.refreshCalls).toBe(2);
	});

	test("rejects one of two concurrent submissions for the same account", async () => {
		// Regression: the "is anything running" checks used to happen well
		// before the account was actually recorded as running (several awaits
		// later), so two concurrent submissions for the same account could
		// both pass every check and both end up executing against the same
		// ship at once. Guarded now by a synchronous claim taken before the
		// first await.
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const makeReq = () =>
			new Request("http://localhost/accounts/p1/goal/async", {
				method: "POST",
				body: JSON.stringify({ type: "ensure-undocked" }),
				headers: { "Content-Type": "application/json" },
			});

		const [resA, resB] = await Promise.all([
			handleExecuteGoalAsync(makeReq(), { playerId: "p1" }, ctx),
			handleExecuteGoalAsync(makeReq(), { playerId: "p1" }, ctx),
		]);

		const statuses = [resA.status, resB.status].sort();
		expect(statuses).toEqual([202, 409]);
	});

	test("does not refresh state before executing when the cache is fresh", async () => {
		const account = makeAccount("p1");
		markStateFresh(account); // just marked — well within the TTL
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/goal/async", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleExecuteGoalAsync(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(202);
		// 1 = 0 pre-execute refresh (fresh cache, skipped) + 1 unconditional post-completion refresh.
		expect(account.refreshCalls).toBe(1);
	});
});

// ── Get Job ──────────────────────────────────────────────────────────

describe("handleGetJob", () => {
	test("returns 404 for unknown job", async () => {
		const ctx = makeContext();
		const res = handleGetJob(
			new Request("http://localhost/jobs/nonexistent"),
			{ jobId: "nonexistent" },
			ctx,
		);
		expect(res.status).toBe(404);
	});

	test("returns running status while job is in flight", async () => {
		const ctx = makeContext();
		const job = ctx.jobManager.create("p1");

		const res = handleGetJob(
			new Request(`http://localhost/jobs/${job.jobId}`),
			{ jobId: job.jobId },
			ctx,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["status"]).toBe("running");
		expect(body["jobId"]).toBe(job.jobId);
		expect(body["accountId"]).toBe("p1");
	});

	test("returns completed result after job finishes", async () => {
		const ctx = makeContext();
		const job = ctx.jobManager.create("p1");
		ctx.jobManager.complete(job.jobId, {
			success: true,
			message: "Done",
			ticksUsed: 1,
			alreadySatisfied: false,
		});

		const res = handleGetJob(
			new Request(`http://localhost/jobs/${job.jobId}`),
			{ jobId: job.jobId },
			ctx,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["status"]).toBe("completed");
		expect(typeof body["completedAt"]).toBe("string");
		const result = body["result"] as Record<string, unknown>;
		expect(result["success"]).toBe(true);
		expect(result["message"]).toBe("Done");
	});

	test("returns failed result after goal throws", async () => {
		const ctx = makeContext();
		const job = ctx.jobManager.create("p1");
		ctx.jobManager.fail(job.jobId, "something went wrong");

		const res = handleGetJob(
			new Request(`http://localhost/jobs/${job.jobId}`),
			{ jobId: job.jobId },
			ctx,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["status"]).toBe("failed");
		expect(body["error"]).toBe("something went wrong");
		expect(typeof body["completedAt"]).toBe("string");
	});
});

// ── Raw Action ──────────────────────────────────────────────────────

describe("handleRawAction", () => {
	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();
		const req = new Request("http://localhost/accounts/unknown/raw", {
			method: "POST",
			body: JSON.stringify({ toolGroup: "spacemolt", action: "get_state" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "unknown" }, ctx);
		expect(res.status).toBe(404);
	});

	test("returns 400 for missing toolGroup", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: JSON.stringify({ action: "get_state" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for missing action", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: JSON.stringify({ toolGroup: "spacemolt" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for path-traversal characters in toolGroup", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: JSON.stringify({ toolGroup: "../admin", action: "get_state" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for path-traversal characters in action", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: JSON.stringify({ toolGroup: "spacemolt", action: "../../secret" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for invalid JSON body", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: "not json",
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(400);
	});

	test("normalizes short tool group name by prepending spacemolt_", async () => {
		let capturedToolGroup = "";
		const account = makeAccount("p1");
		account.send = mock(async (toolGroup: string) => {
			capturedToolGroup = toolGroup;
			return { command: "list", tick: 3, delta: { ship: { fuel: 9 } } };
		}) as typeof account.send;
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: JSON.stringify({ toolGroup: "facility", action: "list" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200);
		expect(capturedToolGroup).toBe("spacemolt_facility");
	});

	test("does not modify tool group that already starts with spacemolt", async () => {
		let capturedToolGroup = "";
		const account = makeAccount("p1");
		account.send = mock(async (toolGroup: string) => {
			capturedToolGroup = toolGroup;
			return { result: "ok", structuredContent: {} };
		}) as typeof account.send;
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: JSON.stringify({ toolGroup: "spacemolt_market", action: "view_market" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200);
		expect(capturedToolGroup).toBe("spacemolt_market");
	});

	test("normalizes a mutation result to the delta envelope (no notifications)", async () => {
		const account = makeAccount("p1");
		account.send = mock(async () => ({
			command: "dock",
			tick: 7,
			delta: { location: { docked_at: "base-1" } },
			autoDocked: true,
		})) as typeof account.send;
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: JSON.stringify({ toolGroup: "spacemolt", action: "dock" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["command"]).toBe("dock");
		expect(body["tick"]).toBe(7);
		expect(body["result"]).toEqual({ location: { docked_at: "base-1" } });
		expect(body["structuredContent"]).toEqual({ location: { docked_at: "base-1" } });
		expect("notifications" in body).toBe(false);
	});

	test("normalizes a query result and omits notifications", async () => {
		const account = makeAccount("p1");
		account.send = mock(async () => ({
			result: "rendered",
			structuredContent: { orders: [{ id: "o1" }] },
		})) as typeof account.send;
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: JSON.stringify({ toolGroup: "spacemolt_market", action: "view_market" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["result"]).toBe("rendered");
		expect(body["structuredContent"]).toEqual({ orders: [{ id: "o1" }] });
		expect("notifications" in body).toBe(false);
	});

	// A bare account.send() has no state-cache side effects — subscribe_market/
	// unsubscribe_market and subscribe_observation/unsubscribe_observation must
	// route through the lib's typed wrapper methods instead, or GET
	// /accounts/:playerId/market|observation keeps serving whatever it last
	// held, forever, regardless of what raw (un)subscribe calls are made.

	test("subscribe_market routes through the typed wrapper so the market cache is actually seeded", async () => {
		const account = new FakeLibManagedAccount({
			playerId: "p1",
			username: "TestPlayer",
			handlers: {
				subscribe_market: () => ({
					result: "ok",
					structuredContent: {
						base_id: "gold_run_extraction_hub",
						items: [
							{
								item_id: "cargo_container",
								sell_orders: [{ price_each: 32, quantity: 5 }],
								buy_orders: [],
							},
						],
					},
				}),
			},
		});
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: JSON.stringify({ toolGroup: "spacemolt_market", action: "subscribe_market" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200);
		const book = account.market("gold_run_extraction_hub");
		expect(book?.items.get("cargo_container")?.sell_orders[0]?.price_each).toBe(32);
	});

	test("unsubscribe_market routes through the typed wrapper so the market cache is actually dropped", async () => {
		const account = new FakeLibManagedAccount({
			playerId: "p1",
			username: "TestPlayer",
			state: { location: { docked_at: "gold_run_extraction_hub" } },
		});
		account.setMarketBook("gold_run_extraction_hub", {
			base_id: "gold_run_extraction_hub",
			tick: 0,
			items: new Map([
				[
					"cargo_container",
					{
						item_id: "cargo_container",
						sell_orders: [{ price_each: 32, quantity: 5 }],
						buy_orders: [],
					},
				],
			]),
		});
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: JSON.stringify({ toolGroup: "spacemolt_market", action: "unsubscribe_market" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200);
		expect(account.market("gold_run_extraction_hub")).toBeUndefined();
	});

	test("subscribe_observation routes through the typed wrapper so the observation cache is actually seeded", async () => {
		const account = new FakeLibManagedAccount({
			playerId: "p1",
			username: "TestPlayer",
			handlers: {
				subscribe_observation: () => ({
					result: "ok",
					structuredContent: {
						action: "subscribe_observation",
						poi_id: "sol_station",
						system_id: "sol",
						active_scan: false,
						unknown_signature: false,
						nearby: [{ player_id: "p2", username: "Nova", in_combat: false }],
						system_agents: [],
						cloaked_contacts: [],
					},
				}),
			},
		});
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: JSON.stringify({ toolGroup: "spacemolt", action: "subscribe_observation" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200);
		expect(account.observation()?.nearby.get("p2")?.username).toBe("Nova");
	});

	test("unsubscribe_observation routes through the typed wrapper so the observation cache is actually cleared", async () => {
		const account = makeAccount("p1");
		account.setObservation({
			poi_id: "sol_station",
			tick: 0,
			nearby: new Map(),
			system: new Map(),
			cloaked: new Map(),
			unknownSignature: false,
			activeScan: false,
		});
		const ctx = makeContext({ accounts: [account] });
		const req = new Request("http://localhost/accounts/p1/raw", {
			method: "POST",
			body: JSON.stringify({ toolGroup: "spacemolt", action: "unsubscribe_observation" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleRawAction(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200);
		expect(account.observation()).toBeNull();
	});
});

// ── Dashboard ────────────────────────────────────────────────────────

describe("handleDashboardData", () => {
	test("returns 200 JSON with accounts array", async () => {
		const account = makeAccount("p1", "Player1");
		const state = makeState({
			player: { id: "p1", username: "Player1", credits: 9500 },
			ship: {
				id: "s1",
				hull: 80,
				max_hull: 100,
				fuel: 40,
				max_fuel: 50,
				cargo_capacity: 100,
				cargo_used: 10,
			},
			location: {
				system_id: "sol",
				system_name: "Sol",
				poi_id: "belt",
				poi_name: "Asteroid Belt",
			},
		});
		const ctx = makeContext({ accounts: [account], state });

		const res = handleDashboardData(new Request("http://localhost/dashboard/data"), {}, ctx);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(Array.isArray(body["accounts"])).toBe(true);
		const accounts = body["accounts"] as Array<Record<string, unknown>>;
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.["username"]).toBe("Player1");
		expect(accounts[0]?.["player_id"]).toBe("p1");
	});

	test("includes uptimeMs and startedAt", async () => {
		const ctx = makeContext();
		const res = handleDashboardData(new Request("http://localhost/dashboard/data"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(typeof body["uptimeMs"]).toBe("number");
		expect(body["startedAt"]).toBe("2026-01-01T00:00:00.000Z");
	});

	test("account entries include state, loop, and recentJobs", async () => {
		const account = makeAccount("p1", "Pilot");
		const ctx = makeContext({ accounts: [account] });
		// Create a job for this account
		ctx.jobManager.create("p1");

		const res = handleDashboardData(new Request("http://localhost/dashboard/data"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		const accounts = body["accounts"] as Array<Record<string, unknown>>;
		const entry = accounts[0] as Record<string, unknown>;
		expect("state" in entry).toBe(true);
		expect("loop" in entry).toBe(true);
		expect(Array.isArray(entry["recentJobs"])).toBe(true);
		const jobs = entry["recentJobs"] as Array<Record<string, unknown>>;
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.["status"]).toBe("running");
	});

	test("returns empty accounts array when no accounts connected", async () => {
		const ctx = makeContext();
		const res = handleDashboardData(new Request("http://localhost/dashboard/data"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		const accounts = body["accounts"] as Array<Record<string, unknown>>;
		expect(accounts).toHaveLength(0);
	});
});

// ── Migrate IDs ──────────────────────────────────────────────────────

describe("handleMigrateIds", () => {
	test("is wired to POST /migrate-ids", () => {
		expect(handleMigrateIds).toBeDefined();
	});

	test("merges categories into flat mapping and returns change report", async () => {
		const migrateResults = [
			{
				playerId: "p1",
				changed: true,
				changes: [{ path: "options.miningSystemId", from: "sol", to: "sol_prime" }],
			},
		];
		const ctx = makeContext();
		(
			ctx.loopManager as unknown as { migrateLoopConfigs: ReturnType<typeof mock> }
		).migrateLoopConfigs = mock(() => Promise.resolve(migrateResults));

		const body = { systems: { sol: "sol_prime" }, items: { ore_iron: "iron_ore" } };
		const req = new Request("http://localhost/migrate-ids", {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleMigrateIds(req, {}, ctx);
		const data = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		// 2 entries across 2 categories
		expect(data["mappingSize"]).toBe(2);
		expect(data["results"]).toHaveLength(1);
		expect((data["results"] as Array<unknown>)[0]).toMatchObject({ playerId: "p1", changed: true });
	});

	test("returns 400 for invalid JSON body", async () => {
		const ctx = makeContext();
		const req = new Request("http://localhost/migrate-ids", {
			method: "POST",
			body: "not json",
		});

		const res = await handleMigrateIds(req, {}, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 400 for non-object body", async () => {
		const ctx = makeContext();
		const req = new Request("http://localhost/migrate-ids", {
			method: "POST",
			body: JSON.stringify([1, 2, 3]),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleMigrateIds(req, {}, ctx);
		expect(res.status).toBe(400);
	});

	test("migrates skill IDs in SQLite game state for all accounts", async () => {
		const ctx = makeContext();
		(
			ctx.loopManager as unknown as { migrateLoopConfigs: ReturnType<typeof mock> }
		).migrateLoopConfigs = mock(() => Promise.resolve([]));

		const skillMigrateResults = [
			{ accountId: "p1", changes: [{ from: "refinement", to: "ore_refinement" }] },
		];
		const mockGetAll = mock(() => ["p1"]);
		const mockMigrateSkillIds = mock((_accountId: string) => ({
			changed: true,
			changes: skillMigrateResults[0]?.changes ?? [],
		}));
		(ctx.store as unknown as Record<string, unknown>)["getAllAccountIds"] = mockGetAll;
		(ctx.store as unknown as Record<string, unknown>)["migrateSkillIds"] = mockMigrateSkillIds;

		const body = { skills: { refinement: "ore_refinement" } };
		const req = new Request("http://localhost/migrate-ids", {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleMigrateIds(req, {}, ctx);
		const data = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect(mockGetAll).toHaveBeenCalled();
		expect(mockMigrateSkillIds).toHaveBeenCalledWith("p1", { refinement: "ore_refinement" });
		const sr = data["skillResults"] as Array<Record<string, unknown>>;
		expect(sr).toHaveLength(1);
		expect(sr[0]).toMatchObject({ accountId: "p1" });
		expect(data["message"]).toContain("1 skill ID(s) remapped");
	});
});

// ── Get System ──────────────────────────────────────────────────────

describe("handleGetSystem", () => {
	test("returns current system when no systemId param", async () => {
		const account = makeAccount("p1");
		const mockGetSystem = mock(() =>
			Promise.resolve({
				structuredContent: { system: { id: "sys-current", name: "Current System" } },
			}),
		);
		account.query = mockGetSystem as unknown as typeof account.query;
		const ctx = makeContext({ accounts: [account] });

		const res = await handleGetSystem(
			new Request("http://localhost/accounts/p1/system"),
			{ playerId: "p1" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect(mockGetSystem).toHaveBeenCalled();
		const sys = body["system"] as Record<string, unknown>;
		expect(sys["id"]).toBe("sys-current");
	});

	test("uses get_system when account is in the requested system", async () => {
		const account = makeAccount("p1");
		const mockGetSystem = mock(() =>
			Promise.resolve({
				structuredContent: { system: { id: "sol", name: "Sol" } },
			}),
		);
		account.query = mockGetSystem as unknown as typeof account.query;
		// Account is in sol — state has matching system_id
		const ctx = makeContext({
			accounts: [account],
			state: makeState({
				location: { system_id: "sol", system_name: "Sol" } as StoredGameState["location"],
			}),
		});

		const res = await handleGetSystem(
			new Request("http://localhost/accounts/p1/system/sol"),
			{ playerId: "p1", systemId: "sol" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect(mockGetSystem).toHaveBeenCalled();
		const sys = body["system"] as Record<string, unknown>;
		expect(sys["id"]).toBe("sol");
	});

	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();

		const res = await handleGetSystem(
			new Request("http://localhost/accounts/unknown/system"),
			{ playerId: "unknown" },
			ctx,
		);

		expect(res.status).toBe(404);
	});
});

describe("handleGetMarket", () => {
	test("returns the serialized book when subscribed", () => {
		const account = makeAccount("p1");
		account.setMarketBook("base-1", {
			base_id: "base-1",
			base_name: "Test Station",
			tick: 5,
			items: new Map([
				[
					"iron_ore",
					{
						item_id: "iron_ore",
						item_name: "Iron Ore",
						buy_orders: [],
						sell_orders: [{ price_each: 10, quantity: 5 }],
					},
				],
			]),
		});
		const ctx = makeContext({ accounts: [account] });

		const res = handleGetMarket(
			new Request("http://localhost/accounts/p1/market/base-1"),
			{ playerId: "p1", baseId: "base-1" },
			ctx,
		);

		expect(res.status).toBe(200);
	});

	test("body flattens items Map to an array", async () => {
		const account = makeAccount("p1");
		account.setMarketBook("base-1", {
			base_id: "base-1",
			tick: 5,
			items: new Map([["iron_ore", { item_id: "iron_ore", buy_orders: [], sell_orders: [] }]]),
		});
		const ctx = makeContext({ accounts: [account] });

		const res = handleGetMarket(
			new Request("http://localhost/accounts/p1/market/base-1"),
			{ playerId: "p1", baseId: "base-1" },
			ctx,
		);
		const body = (await res.json()) as { base_id: string; tick: number; items: unknown[] };

		expect(body.base_id).toBe("base-1");
		expect(body.tick).toBe(5);
		expect(body.items).toEqual([{ item_id: "iron_ore", buy_orders: [], sell_orders: [] }]);
	});

	test("returns 404 when not subscribed", () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const res = handleGetMarket(
			new Request("http://localhost/accounts/p1/market/base-1"),
			{ playerId: "p1", baseId: "base-1" },
			ctx,
		);

		expect(res.status).toBe(404);
	});

	test("returns 404 for unknown account", () => {
		const ctx = makeContext();

		const res = handleGetMarket(
			new Request("http://localhost/accounts/unknown/market/base-1"),
			{ playerId: "unknown", baseId: "base-1" },
			ctx,
		);

		expect(res.status).toBe(404);
	});

	test("returns 400 when baseId missing", () => {
		const ctx = makeContext();

		const res = handleGetMarket(
			new Request("http://localhost/accounts/p1/market/"),
			{ playerId: "p1" },
			ctx,
		);

		expect(res.status).toBe(400);
	});
});

describe("handleGetObservation", () => {
	test("returns the serialized view when subscribed", async () => {
		const account = makeAccount("p1");
		account.setObservation({
			poi_id: "sol_station",
			system_id: "sol",
			tick: 3,
			nearby: new Map([["p2", { player_id: "p2", username: "Other", in_combat: false }]]),
			system: new Map(),
			cloaked: new Map(),
			unknownSignature: false,
			activeScan: true,
		});
		const ctx = makeContext({ accounts: [account] });

		const res = handleGetObservation(
			new Request("http://localhost/accounts/p1/observation"),
			{ playerId: "p1" },
			ctx,
		);
		const body = (await res.json()) as {
			poi_id: string;
			nearby: unknown[];
			activeScan: boolean;
		};

		expect(res.status).toBe(200);
		expect(body.poi_id).toBe("sol_station");
		expect(body.activeScan).toBe(true);
		expect(body.nearby).toEqual([{ player_id: "p2", username: "Other", in_combat: false }]);
	});

	test("returns 404 when not subscribed", () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const res = handleGetObservation(
			new Request("http://localhost/accounts/p1/observation"),
			{ playerId: "p1" },
			ctx,
		);

		expect(res.status).toBe(404);
	});

	test("returns 404 for unknown account", () => {
		const ctx = makeContext();

		const res = handleGetObservation(
			new Request("http://localhost/accounts/unknown/observation"),
			{ playerId: "unknown" },
			ctx,
		);

		expect(res.status).toBe(404);
	});
});

describe("handleCraftingEvents", () => {
	function craftingUpdate(runsDone: number): CraftingUpdateEvent {
		return {
			tick: 100 + runsDone,
			jobs: [
				{
					job_id: "job-1",
					completed: runsDone === 5,
					deposited: [],
					mode: "craft",
					recipe: "widget",
					runs_done: runsDone,
					runs_remaining: 5 - runsDone,
					storage: "personal",
					venue: "workshop",
				},
			],
		};
	}

	async function readSseEvents(res: Response, count: number): Promise<CraftingUpdateEnvelope[]> {
		const reader = res.body?.getReader();
		if (!reader) throw new Error("Response has no body");
		const decoder = new TextDecoder();
		let buffered = "";
		const events: CraftingUpdateEnvelope[] = [];
		while (events.length < count) {
			const { value, done } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
			let boundary = buffered.indexOf("\n\n");
			while (boundary !== -1) {
				const frame = buffered.slice(0, boundary);
				buffered = buffered.slice(boundary + 2);
				if (frame.startsWith("data: ")) {
					events.push(JSON.parse(frame.slice("data: ".length)));
				}
				boundary = buffered.indexOf("\n\n");
			}
		}
		await reader.cancel();
		return events;
	}

	test("returns 400 when playerId missing", () => {
		const ctx = makeContext();
		const res = handleCraftingEvents(
			new Request("http://localhost/accounts//crafting/events"),
			{},
			ctx,
		);
		expect(res.status).toBe(400);
	});

	test("returns 404 for unknown account", () => {
		const ctx = makeContext();
		const res = handleCraftingEvents(
			new Request("http://localhost/accounts/unknown/crafting/events"),
			{ playerId: "unknown" },
			ctx,
		);
		expect(res.status).toBe(404);
	});

	test("sets SSE headers", () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		const res = handleCraftingEvents(
			new Request("http://localhost/accounts/p1/crafting/events"),
			{ playerId: "p1" },
			ctx,
		);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
		expect(res.headers.get("Connection")).toBe("keep-alive");
	});

	test("streams the buffered backlog immediately on connect", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		ctx.craftingEventsStore.record("p1", craftingUpdate(1));
		ctx.craftingEventsStore.record("p1", craftingUpdate(2));

		const res = handleCraftingEvents(
			new Request("http://localhost/accounts/p1/crafting/events"),
			{ playerId: "p1" },
			ctx,
		);

		const events = await readSseEvents(res, 2);
		expect(events).toHaveLength(2);
		expect(events[0]?.event.jobs[0]?.runs_done).toBe(1);
		expect(events[1]?.event.jobs[0]?.runs_done).toBe(2);
	});

	test("streams live events recorded after connecting", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const res = handleCraftingEvents(
			new Request("http://localhost/accounts/p1/crafting/events"),
			{ playerId: "p1" },
			ctx,
		);

		ctx.craftingEventsStore.record("p1", craftingUpdate(3));
		const events = await readSseEvents(res, 1);
		expect(events[0]?.event.jobs[0]?.runs_done).toBe(3);
	});

	test("resolves the account by username, keying the store by player_id", async () => {
		const account = makeAccount("p1", "Alice");
		const ctx = makeContext({ accounts: [account] });
		ctx.craftingEventsStore.record("p1", craftingUpdate(1));

		const res = handleCraftingEvents(
			new Request("http://localhost/accounts/Alice/crafting/events"),
			{ playerId: "Alice" },
			ctx,
		);

		const events = await readSseEvents(res, 1);
		expect(events[0]?.event.jobs[0]?.runs_done).toBe(1);
	});

	test("does not deliver another account's events", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });

		const res = handleCraftingEvents(
			new Request("http://localhost/accounts/p1/crafting/events"),
			{ playerId: "p1" },
			ctx,
		);
		ctx.craftingEventsStore.record("p2", craftingUpdate(1));
		ctx.craftingEventsStore.record("p1", craftingUpdate(9));

		const events = await readSseEvents(res, 1);
		expect(events).toHaveLength(1);
		expect(events[0]?.event.jobs[0]?.runs_done).toBe(9);
	});
});
