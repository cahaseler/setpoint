import { describe, expect, mock, test } from "bun:test";
import type { ManagedAccount, PendingAccount } from "../../src/accounts/manager.js";
import type { AccountManager } from "../../src/accounts/manager.js";
import {
	type HandlerContext,
	handleAbortAccount,
	handleAddAccount,
	handleDashboardData,
	handleDeleteAccount,
	handleExecuteGoal,
	handleExecuteGoalAsync,
	handleGameProxy,
	handleGetAccount,
	handleGetJob,
	handleGetLogLevel,
	handleGetLoop,
	handleGetSessionId,
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
import { createMemoryDatabase } from "../../src/state/database.js";
import type { StateStore } from "../../src/state/store.js";
import type { StoredGameState } from "../../src/state/store.js";

// ── Mock Factories ───────────────────────────────────────────────────

function makeAccount(
	playerId: string,
	username = "TestPlayer",
	sessionId: string | undefined = "sess-123",
): ManagedAccount {
	return {
		config: { username, password: "pass", player_id: playerId },
		session: { sessionId } as unknown as ManagedAccount["session"],
		endpoints: {} as ManagedAccount["endpoints"],
	};
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
		accounts: ManagedAccount[];
		state: StoredGameState | null;
		loopStatus: LoopStatus | undefined;
		loopRunning: boolean;
		queueResult: PendingAccount | Error;
		pendingAccounts: PendingAccount[];
		pendingByPlayerId: PendingAccount | undefined;
		pendingByUsername: PendingAccount | undefined;
	}> = {},
): HandlerContext {
	const accounts = overrides.accounts ?? [];
	const accountMap = new Map(accounts.map((a) => [a.config.player_id, a]));

	const manager = {
		get size() {
			return accountMap.size;
		},
		getAll: mock(() => accounts),
		getByPlayerId: mock((id: string) => accountMap.get(id)),
		getByUsername: mock((username: string) => {
			const lower = username.toLowerCase();
			return accounts.find((a) => a.config.username.toLowerCase() === lower);
		}),
		connectAccount: mock(() => Promise.resolve(accounts[0])),
		connectByCredentials: mock(() => Promise.resolve(accounts[0])),
		disconnectAccount: mock(() => {}),
		queueAccount:
			overrides.queueResult instanceof Error
				? mock(() => {
						throw overrides.queueResult;
					})
				: mock(
						() =>
							overrides.queueResult ?? {
								username: "NewPlayer",
								credentials: { username: "NewPlayer", password: "secret" },
								status: "pending" as const,
								queuedAt: new Date().toISOString(),
								playerId: "p-new",
							},
					),
		queueByCredentials:
			overrides.queueResult instanceof Error
				? mock(() => {
						throw overrides.queueResult;
					})
				: mock(
						() =>
							overrides.queueResult ?? {
								username: "NewPlayer",
								credentials: { username: "NewPlayer", password: "secret" },
								status: "pending" as const,
								queuedAt: new Date().toISOString(),
							},
					),
		getAllPending: mock(() => overrides.pendingAccounts ?? []),
		getPending: mock(() => overrides.pendingByUsername),
		getPendingByPlayerId: mock(() => overrides.pendingByPlayerId),
		removePending: mock(() => true),
	} as unknown as AccountManager;

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

		const res = handleListAccounts(new Request("http://localhost/accounts"), {}, ctx);
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

		const res = handleListAccounts(new Request("http://localhost/accounts"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		const accounts = body["accounts"] as Array<Record<string, unknown>>;
		expect(accounts[0]?.["status"]).toBe("connected");
	});

	test("includes pending accounts in list", async () => {
		const pendingAccounts: PendingAccount[] = [
			{
				username: "PendingPlayer",
				credentials: { username: "PendingPlayer", password: "pass" },
				status: "pending",
				queuedAt: new Date().toISOString(),
				playerId: "p-pending",
			},
		];
		const ctx = makeContext({ pendingAccounts });

		const res = handleListAccounts(new Request("http://localhost/accounts"), {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		const accounts = body["accounts"] as Array<Record<string, unknown>>;
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.["player_id"]).toBe("p-pending");
		expect(accounts[0]?.["username"]).toBe("PendingPlayer");
		expect(accounts[0]?.["status"]).toBe("pending");
		expect(accounts[0]?.["credits"]).toBeNull();
		expect(accounts[0]?.["ship"]).toBeNull();
		expect(accounts[0]?.["location"]).toBeNull();
		expect(accounts[0]?.["loop"]).toBeNull();
	});

	test("returns empty array when no accounts", async () => {
		const ctx = makeContext();

		const res = handleListAccounts(new Request("http://localhost/accounts"), {}, ctx);
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

	test("returns pending account by player_id", async () => {
		const pending: PendingAccount = {
			username: "PendingPlayer",
			credentials: { username: "PendingPlayer", password: "pass" },
			status: "connecting",
			queuedAt: new Date().toISOString(),
			playerId: "p-pending",
		};
		const ctx = makeContext({ pendingByPlayerId: pending });

		const res = handleGetAccount(
			new Request("http://localhost/accounts/p-pending"),
			{ playerId: "p-pending" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["player_id"]).toBe("p-pending");
		expect(body["username"]).toBe("PendingPlayer");
		expect(body["status"]).toBe("connecting");
		expect(body["state"]).toBeNull();
		expect(body["loop"]).toBeNull();
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
	test("queues account with full config and returns 202", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/accounts", {
			method: "POST",
			body: JSON.stringify({
				username: "NewPlayer",
				password: "secret",
				player_id: "p-new",
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleAddAccount(req, {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(202);
		expect(body["player_id"]).toBe("p-new");
		expect(body["username"]).toBe("NewPlayer");
		expect(body["status"]).toBe("pending");
		expect(body["message"]).toBe("Account queued for connection");
	});

	test("queues account with credentials only and returns 202", async () => {
		const ctx = makeContext({
			queueResult: {
				username: "CredPlayer",
				credentials: { username: "CredPlayer", password: "secret" },
				status: "pending",
				queuedAt: new Date().toISOString(),
			},
		});

		const req = new Request("http://localhost/accounts", {
			method: "POST",
			body: JSON.stringify({
				username: "CredPlayer",
				password: "secret",
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleAddAccount(req, {}, ctx);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(202);
		expect(body["player_id"]).toBeNull();
		expect(body["username"]).toBe("CredPlayer");
		expect(body["status"]).toBe("pending");
		expect(body["message"]).toBe("Account queued for connection");
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

	test("returns 400 for invalid account config", async () => {
		const ctx = makeContext();

		const req = new Request("http://localhost/accounts", {
			method: "POST",
			body: JSON.stringify({ username: "" }),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleAddAccount(req, {}, ctx);
		expect(res.status).toBe(400);
	});

	test("returns 409 when queueAccount throws duplicate", async () => {
		const ctx = makeContext({ queueResult: new Error("Account already connected") });

		const req = new Request("http://localhost/accounts", {
			method: "POST",
			body: JSON.stringify({
				username: "NewPlayer",
				password: "secret",
				player_id: "p-new",
			}),
			headers: { "Content-Type": "application/json" },
		});

		const res = await handleAddAccount(req, {}, ctx);
		expect(res.status).toBe(409);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["error"]).toBe("Account already connected");
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
		expect(ctx.manager.disconnectAccount).toHaveBeenCalledWith("p1");
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

	test("removes pending account and returns success", async () => {
		const pending: PendingAccount = {
			username: "PendingPlayer",
			credentials: { username: "PendingPlayer", password: "pass" },
			status: "pending",
			queuedAt: new Date().toISOString(),
			playerId: "p-pending",
		};
		const ctx = makeContext({ pendingByPlayerId: pending });

		const res = await handleDeleteAccount(
			new Request("http://localhost/accounts/p-pending", { method: "DELETE" }),
			{ playerId: "p-pending" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["message"]).toBe("Pending account removed");
		expect(body["username"]).toBe("PendingPlayer");
		expect(ctx.manager.removePending).toHaveBeenCalledWith("PendingPlayer");
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

	test("ignores cashSource personal (only faction is valid)", async () => {
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
		expect(res.status).toBe(201);

		const calls = (ctx.loopManager.startMiningLoop as ReturnType<typeof mock>).mock.calls;
		const opts = calls[0]?.[1] as Record<string, unknown>;
		expect(opts["cashSource"]).toBeUndefined();
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
		expect(body["error"] as string).toContain("targetSystemId");
	});

	test("waits for executing goal to finish then proceeds", async () => {
		const account = makeAccount("p1");
		const ctx = makeContext({ accounts: [account] });
		// Simulate a goal already executing — clear it after 100ms
		ctx.executingGoals.set("p1", {
			goalType: "test-goal",
			startedAt: new Date().toISOString(),
			controller: new AbortController(),
			progress: { goalType: "test-goal", completedSteps: [], remainingSteps: [] },
			promise: Promise.resolve(),
		});
		setTimeout(() => ctx.executingGoals.delete("p1"), 100);

		const req = new Request("http://localhost/accounts/p1/goal", {
			method: "POST",
			body: JSON.stringify({ type: "ensure-undocked" }),
			headers: { "Content-Type": "application/json" },
		});

		// Should wait for the lock to clear, then execute (will fail because
		// account.endpoints is empty, but it should get past the lock wait).
		// Streaming response: handler returns 200 immediately; drain body to wait for goal.
		const res = await handleExecuteGoal(req, { playerId: "p1" }, ctx);
		expect(res.status).toBe(200); // not 409 — lock cleared and goal started
		await res.text(); // drain to let goal finish and avoid dangling async
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

// ── Get Session ID ──────────────────────────────────────────────────

describe("handleGetSessionId", () => {
	test("returns session_id for connected account", async () => {
		const account = makeAccount("p1", "TestPlayer", "sess-abc");
		account.session = {
			sessionId: "sess-abc",
			execute: async () => ({}),
		} as unknown as ManagedAccount["session"];
		const ctx = makeContext({ accounts: [account] });

		const res = await handleGetSessionId(
			new Request("http://localhost/accounts/p1/session"),
			{ playerId: "p1" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["session_id"]).toBe("sess-abc");
		expect(body["player_id"]).toBe("p1");
		expect(body["username"]).toBe("TestPlayer");
	});

	test("resolves by username (case-insensitive)", async () => {
		const account = makeAccount("p1", "TestPlayer", "sess-abc");
		account.session = {
			sessionId: "sess-abc",
			execute: async () => ({}),
		} as unknown as ManagedAccount["session"];
		const ctx = makeContext({ accounts: [account] });

		const res = await handleGetSessionId(
			new Request("http://localhost/accounts/testplayer/session"),
			{ playerId: "testplayer" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["session_id"]).toBe("sess-abc");
	});

	test("returns 404 for unknown account", async () => {
		const ctx = makeContext();

		const res = await handleGetSessionId(
			new Request("http://localhost/accounts/nope/session"),
			{ playerId: "nope" },
			ctx,
		);
		expect(res.status).toBe(404);
	});

	test("returns 503 when session has no active ID", async () => {
		const account = makeAccount("p1", "TestPlayer");
		// Override session to have no sessionId (simulating recovering/disconnected state)
		account.session = { sessionId: undefined } as unknown as ManagedAccount["session"];
		const ctx = makeContext({ accounts: [account] });

		const res = await handleGetSessionId(
			new Request("http://localhost/accounts/p1/session"),
			{ playerId: "p1" },
			ctx,
		);
		expect(res.status).toBe(503);
	});

	test("returns 400 when playerId missing", async () => {
		const ctx = makeContext();

		const res = await handleGetSessionId(
			new Request("http://localhost/accounts//session"),
			{},
			ctx,
		);
		expect(res.status).toBe(400);
	});

	test("recovers stale session before returning", async () => {
		const account = makeAccount("p1", "TestPlayer", "stale-sess");
		// Simulate: execute triggers recovery, which updates sessionId
		account.session = {
			sessionId: "stale-sess",
			execute: async () => {
				// Recovery happened — sessionId updated
				(account.session as unknown as { sessionId: string }).sessionId = "fresh-sess";
				return {};
			},
		} as unknown as ManagedAccount["session"];
		const ctx = makeContext({ accounts: [account] });

		const res = await handleGetSessionId(
			new Request("http://localhost/accounts/p1/session"),
			{ playerId: "p1" },
			ctx,
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(200);
		expect(body["session_id"]).toBe("fresh-sess");
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
		account.session = {
			...account.session,
			execute: mock(async (toolGroup: string) => {
				capturedToolGroup = toolGroup;
				return {
					result: "ok",
					structuredContent: {},
					notifications: [],
					session: undefined,
				};
			}),
		} as unknown as ManagedAccount["session"];
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
		account.session = {
			...account.session,
			execute: mock(async (toolGroup: string) => {
				capturedToolGroup = toolGroup;
				return {
					result: "ok",
					structuredContent: {},
					notifications: [],
					session: undefined,
				};
			}),
		} as unknown as ManagedAccount["session"];
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
		account.endpoints.getSystem =
			mockGetSystem as unknown as ManagedAccount["endpoints"]["getSystem"];
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
		account.endpoints.getSystem =
			mockGetSystem as unknown as ManagedAccount["endpoints"]["getSystem"];
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

describe("handleGameProxy", () => {
	test("forwards the sub-path, session, body, and content-type to the client and relays the response", async () => {
		const ctx = makeContext();
		const forward = mock(
			async (
				_method: string,
				_path: string,
				_body: string | undefined,
				_sessionId: string | undefined,
				_contentType: string | undefined,
			) => ({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ structuredContent: { ok: true } }),
			}),
		);
		ctx.client = { forward } as unknown as HandlerContext["client"];

		const req = new Request("http://localhost/gameproxy/api/v2/spacemolt/travel?foo=bar", {
			method: "POST",
			body: JSON.stringify({ id: "sol" }),
			headers: { "Content-Type": "application/json", "X-Session-Id": "sess-abc" },
		});

		const res = await handleGameProxy(req, {}, ctx);

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/json");
		expect(await res.json()).toEqual({ structuredContent: { ok: true } });

		const call = forward.mock.calls[0];
		expect(call?.[0]).toBe("POST");
		expect(call?.[1]).toBe("/api/v2/spacemolt/travel?foo=bar");
		expect(call?.[2]).toBe(JSON.stringify({ id: "sol" }));
		expect(call?.[3]).toBe("sess-abc");
		expect(call?.[4]).toBe("application/json");
	});

	test("rejects a path outside the /api/v2/ namespace with 400", async () => {
		const ctx = makeContext();
		const forward = mock(async () => ({
			status: 200,
			contentType: "application/json",
			body: "{}",
		}));
		ctx.client = { forward } as unknown as HandlerContext["client"];

		const req = new Request("http://localhost/gameproxy/etc/passwd", { method: "GET" });
		const res = await handleGameProxy(req, {}, ctx);

		expect(res.status).toBe(400);
		expect(forward).not.toHaveBeenCalled();
	});

	test("relays a non-2xx game response verbatim instead of throwing", async () => {
		const ctx = makeContext();
		ctx.client = {
			forward: mock(async () => ({
				status: 400,
				contentType: "application/json",
				body: JSON.stringify({ error: { code: "bad_request" } }),
			})),
		} as unknown as HandlerContext["client"];

		const req = new Request("http://localhost/gameproxy/api/v2/spacemolt/buy", {
			method: "POST",
			body: "{}",
		});

		const res = await handleGameProxy(req, {}, ctx);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: { code: "bad_request" } });
	});

	test("does not send a body for GET requests", async () => {
		const ctx = makeContext();
		const forward = mock(
			async (
				_method: string,
				_path: string,
				_body: string | undefined,
				_sessionId: string | undefined,
				_contentType: string | undefined,
			) => ({
				status: 200,
				contentType: "application/json",
				body: "{}",
			}),
		);
		ctx.client = { forward } as unknown as HandlerContext["client"];

		const req = new Request("http://localhost/gameproxy/api/v2/notifications", {
			method: "GET",
		});
		await handleGameProxy(req, {}, ctx);

		expect(forward.mock.calls[0]?.[0]).toBe("GET");
		expect(forward.mock.calls[0]?.[1]).toBe("/api/v2/notifications");
		expect(forward.mock.calls[0]?.[2]).toBeUndefined();
	});

	test("returns 502 when the forward fails", async () => {
		const ctx = makeContext();
		ctx.client = {
			forward: mock(async () => {
				throw new Error("network down");
			}),
		} as unknown as HandlerContext["client"];

		const req = new Request("http://localhost/gameproxy/api/v2/spacemolt/get_state", {
			method: "POST",
			body: "{}",
		});

		const res = await handleGameProxy(req, {}, ctx);
		expect(res.status).toBe(502);
	});
});
