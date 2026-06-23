import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { ManagedAccount } from "../../src/accounts/manager.js";
import type { AccountManager } from "../../src/accounts/manager.js";
import type { GameEndpoints } from "../../src/api/endpoints.js";
import type { HandlerContext } from "../../src/server/handlers.js";
import {
	handleAddAccount,
	handleDashboardData,
	handleDeleteAccount,
	handleExecuteGoalAsync,
	handleGetAccount,
	handleGetJob,
	handleGetLoop,
	handleGetSessionId,
	handleGetState,
	handleGetStateSection,
	handleHealth,
	handleListAccounts,
	handleStartLoop,
} from "../../src/server/handlers.js";
import { JobManager } from "../../src/server/job-manager.js";
import { LoopManager } from "../../src/server/loop-manager.js";
import { Router } from "../../src/server/router.js";
import { createMemoryDatabase } from "../../src/state/database.js";
import type { StateStore } from "../../src/state/store.js";
import type { StoredGameState } from "../../src/state/store.js";

// ── Test Data ────────────────────────────────────────────────────────

const TEST_STATE: StoredGameState = {
	player: {
		credits: 5000,
		id: "p1",
		username: "MockPilot",
		empire: "solarian",
	} as StoredGameState["player"],
	ship: {
		id: "ship-1",
		class_id: "scout",
		name: "Mock Scout",
		hull: 80,
		max_hull: 100,
		fuel: 40,
		max_fuel: 50,
		cargo_capacity: 20,
		cargo_used: 5,
	} as StoredGameState["ship"],
	cargo: [
		{ item_id: "ore", item_name: "Iron Ore", quantity: 5, size: 1 },
	] as StoredGameState["cargo"],
	location: {
		system_id: "sol",
		system_name: "Sol",
		poi_id: "sol_station",
		poi_name: "Sol Station",
		docked_at: "sol_base",
	} as StoredGameState["location"],
	modules: undefined,
	skills: undefined,
	missions: undefined,
	queue: undefined,
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeMockAccount(
	playerId: string,
	username: string,
	sessionId = "sess-mock",
): ManagedAccount {
	return {
		config: { username, password: "pass", player_id: playerId },
		session: { disconnect: mock(() => {}), sessionId } as unknown as ManagedAccount["session"],
		endpoints: {
			getState: mock(() => Promise.resolve({})),
		} as unknown as GameEndpoints,
	};
}

// ── Server Setup ─────────────────────────────────────────────────────

describe("Server integration", () => {
	let server: ReturnType<typeof Bun.serve>;
	let base: string;
	const accounts = [makeMockAccount("p1", "MockPilot"), makeMockAccount("p2", "SecondPilot")];

	beforeAll(() => {
		const accountMap = new Map(accounts.map((a) => [a.config.player_id, a]));

		const manager = {
			get size() {
				return accountMap.size;
			},
			getAll: mock(() => [...accountMap.values()]),
			getByPlayerId: mock((id: string) => accountMap.get(id)),
			getByUsername: mock((username: string) => {
				const lower = username.toLowerCase();
				for (const a of accountMap.values()) {
					if (a.config.username.toLowerCase() === lower) return a;
				}
				return undefined;
			}),
			connectAccount: mock((config: { player_id: string; username: string }) => {
				const account = makeMockAccount(config.player_id, config.username);
				accountMap.set(config.player_id, account);
				return Promise.resolve(account);
			}),
			disconnectAccount: mock((id: string) => {
				accountMap.delete(id);
			}),
			getAllPending: mock(() => []),
			getPending: mock(() => undefined),
			getPendingByPlayerId: mock(() => undefined),
			removePending: mock(() => true),
		} as unknown as AccountManager;

		const store = {
			getState: mock((id: string) => (id === "p1" ? TEST_STATE : null)),
			getSection: mock((id: string, section: string) => {
				if (id !== "p1") return undefined;
				return TEST_STATE[section as keyof StoredGameState];
			}),
		} as unknown as StateStore;

		const loopManager = new LoopManager();
		const jobManager = new JobManager(createMemoryDatabase());

		const ctx: HandlerContext = {
			manager,
			store,
			loopManager,
			jobManager,
			client: {} as HandlerContext["client"],
			configDir: "config",
			startedAt: new Date().toISOString(),
			executingGoals: new Map(),
		};

		const router = new Router<HandlerContext>();
		router.get("/health", handleHealth);
		router.get("/accounts", handleListAccounts);
		router.get("/accounts/:playerId", handleGetAccount);
		router.post("/accounts", handleAddAccount);
		router.delete("/accounts/:playerId", handleDeleteAccount);
		router.get("/accounts/:playerId/session", handleGetSessionId);
		router.get("/accounts/:playerId/state", handleGetState);
		router.get("/accounts/:playerId/state/:section", handleGetStateSection);
		router.get("/accounts/:playerId/loop", handleGetLoop);
		router.post("/accounts/:playerId/loop", handleStartLoop);
		router.post("/accounts/:playerId/goal/async", handleExecuteGoalAsync);
		router.get("/jobs/:jobId", handleGetJob);
		router.get("/dashboard/data", handleDashboardData);

		server = Bun.serve({
			port: 0, // random available port
			fetch: (req) => router.handle(req, ctx),
		});

		base = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server.stop();
	});

	// ── Health ───────────────────────────────────────────────────────

	test("GET /health returns ok", async () => {
		const res = await fetch(`${base}/health`);
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect(body["status"]).toBe("ok");
		expect(body["accounts"]).toBe(2);
		expect(typeof body["uptime"]).toBe("number");
	});

	// ── Accounts ─────────────────────────────────────────────────────

	test("GET /accounts lists all accounts", async () => {
		const res = await fetch(`${base}/accounts`);
		const body = (await res.json()) as Record<string, unknown>;
		const list = body["accounts"] as Array<Record<string, unknown>>;

		expect(res.status).toBe(200);
		expect(list).toHaveLength(2);
		expect(list.some((a) => a["username"] === "MockPilot")).toBe(true);
		expect(list.some((a) => a["username"] === "SecondPilot")).toBe(true);
	});

	test("GET /accounts/:playerId returns account detail", async () => {
		const res = await fetch(`${base}/accounts/p1`);
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect(body["player_id"]).toBe("p1");
		expect(body["username"]).toBe("MockPilot");

		const state = body["state"] as Record<string, unknown>;
		expect(state["credits"]).toBe(5000);
	});

	test("GET /accounts/:playerId returns 404 for unknown", async () => {
		const res = await fetch(`${base}/accounts/nope`);
		expect(res.status).toBe(404);
	});

	// ── Session ──────────────────────────────────────────────────────

	test("GET /accounts/:playerId/session returns session_id", async () => {
		const res = await fetch(`${base}/accounts/p1/session`);
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect(body["session_id"]).toBe("sess-mock");
		expect(body["player_id"]).toBe("p1");
		expect(body["username"]).toBe("MockPilot");
	});

	test("GET /accounts/:playerId/session resolves by username", async () => {
		const res = await fetch(`${base}/accounts/MockPilot/session`);
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect(body["session_id"]).toBe("sess-mock");
	});

	test("GET /accounts/:playerId/session returns 404 for unknown", async () => {
		const res = await fetch(`${base}/accounts/nobody/session`);
		expect(res.status).toBe(404);
	});

	// ── State ────────────────────────────────────────────────────────

	test("GET /accounts/:playerId/state returns full state", async () => {
		const res = await fetch(`${base}/accounts/p1/state`);
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect((body["player"] as Record<string, unknown>)["credits"]).toBe(5000);
		expect((body["location"] as Record<string, unknown>)["system_name"]).toBe("Sol");
	});

	test("GET /accounts/:playerId/state/:section returns single section", async () => {
		const res = await fetch(`${base}/accounts/p1/state/ship`);
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect(body["hull"]).toBe(80);
		expect(body["max_hull"]).toBe(100);
	});

	test("GET /accounts/:playerId/state/:section returns 400 for invalid section", async () => {
		const res = await fetch(`${base}/accounts/p1/state/bogus`);
		expect(res.status).toBe(400);
	});

	test("GET /accounts/:playerId/state returns 404 for account without state", async () => {
		const res = await fetch(`${base}/accounts/p2/state`);
		expect(res.status).toBe(404);
	});

	// ── Loop lifecycle ───────────────────────────────────────────────

	test("GET /accounts/:playerId/loop returns not running initially", async () => {
		const res = await fetch(`${base}/accounts/p1/loop`);
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(200);
		expect(body["running"]).toBe(false);
	});

	test("POST /accounts/:playerId/loop returns 400 for missing options", async () => {
		const res = await fetch(`${base}/accounts/p1/loop`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				type: "mining",
				options: { miningSystemId: "sol" },
			}),
		});
		expect(res.status).toBe(400);
	});

	// ── Async Goal Jobs ──────────────────────────────────────────────

	test("POST /accounts/:playerId/goal/async returns 202 with job_id, GET /jobs/:id returns result", async () => {
		// Use ensure-fueled with targetFuel <= current fuel (40) so it returns alreadySatisfied
		// without making any API calls beyond getState.
		const res = await fetch(`${base}/accounts/p1/goal/async`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "ensure-fueled", options: { targetFuel: 40 } }),
		});
		expect(res.status).toBe(202);
		const submitted = (await res.json()) as Record<string, unknown>;
		const jobId = submitted["job_id"] as string;
		expect(typeof jobId).toBe("string");
		expect(jobId.length).toBeGreaterThan(0);

		// Poll until the job completes (ensure-undocked is instant in tests)
		let jobBody: Record<string, unknown> = {};
		for (let i = 0; i < 20; i++) {
			await Bun.sleep(10);
			const pollRes = await fetch(`${base}/jobs/${jobId}`);
			expect(pollRes.status).toBe(200);
			jobBody = (await pollRes.json()) as Record<string, unknown>;
			if (jobBody["status"] !== "running") break;
		}

		expect(jobBody["status"]).toBe("completed");
		expect(jobBody["jobId"]).toBe(jobId);
		const result = jobBody["result"] as Record<string, unknown>;
		expect(result["success"]).toBe(true);
	});

	test("GET /jobs/:jobId returns 404 for unknown job", async () => {
		const res = await fetch(`${base}/jobs/nonexistent`);
		expect(res.status).toBe(404);
	});

	// ── 404 ──────────────────────────────────────────────────────────

	test("unknown routes return 404", async () => {
		const res = await fetch(`${base}/nonexistent`);
		expect(res.status).toBe(404);
	});

	test("wrong method returns 404", async () => {
		const res = await fetch(`${base}/health`, { method: "DELETE" });
		expect(res.status).toBe(404);
	});

	// ── Dashboard ─────────────────────────────────────────────────────

	test("GET /dashboard/data returns 200 JSON with accounts and uptime", async () => {
		const res = await fetch(`${base}/dashboard/data`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(Array.isArray(body["accounts"])).toBe(true);
		expect(typeof body["uptimeMs"]).toBe("number");
		expect(typeof body["startedAt"]).toBe("string");
		const accounts = body["accounts"] as Array<Record<string, unknown>>;
		// Integration test context has 2 connected accounts (p1, p2)
		expect(accounts).toHaveLength(2);
		const names = accounts.map((a) => a["username"]);
		expect(names).toContain("MockPilot");
		expect(names).toContain("SecondPilot");
	});
});
