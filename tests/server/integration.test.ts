import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { CombatEnvelope, PirateRadioEnvelope } from "@setpoint/protocol";
import type { GameState } from "@spacemolt/lib";
import type { CombatModeStore } from "../../src/combat/combat-mode-store.js";
import type { HandlerContext } from "../../src/server/handlers.js";
import { errorResponse } from "../../src/server/http.js";
import { buildRoutes } from "../../src/server/index.js";
import { JobManager } from "../../src/server/job-manager.js";
import { LoopManager } from "../../src/server/loop-manager.js";
import { CraftingEventsStore } from "../../src/state/crafting-events-store.js";
import { createMemoryDatabase } from "../../src/state/database.js";
import { type EventBuffer, createEventBuffer } from "../../src/state/event-buffer.js";
import type { StateStore } from "../../src/state/store.js";
import type { StoredGameState } from "../../src/state/store.js";
import { FakeLibManagedAccount, makeFakeLibManager } from "../dispatcher/lib-fakes.js";
import { makePirateRadioEvent } from "../helpers/pirate-radio.js";

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
	state?: GameState,
): FakeLibManagedAccount {
	return new FakeLibManagedAccount({ playerId, username, ...(state ? { state } : {}) });
}

// ── Server Setup ─────────────────────────────────────────────────────

describe("Server integration", () => {
	let server: ReturnType<typeof Bun.serve>;
	let base: string;
	let pirateRadioStore: EventBuffer<PirateRadioEnvelope>;
	// Seed p1's push-fed cache with TEST_STATE so goal execution (which reads
	// account.state) sees a fueled ship; read handlers get state from the store stub.
	const accounts = [
		makeMockAccount("p1", "MockPilot", TEST_STATE as unknown as GameState),
		makeMockAccount("p2", "SecondPilot"),
	];

	beforeAll(() => {
		const manager = makeFakeLibManager(accounts);

		const store = {
			getState: mock((id: string) => (id === "p1" ? TEST_STATE : null)),
			getSection: mock((id: string, section: string) => {
				// Lets a test drive a handler into throwing, so the route wrapper's
				// catch-and-500 is exercised over real HTTP.
				if (section === "queue") throw new Error("boom");
				if (id !== "p1") return undefined;
				return TEST_STATE[section as keyof StoredGameState];
			}),
		} as unknown as StateStore;

		const loopManager = new LoopManager();
		const jobManager = new JobManager(createMemoryDatabase());

		pirateRadioStore = createEventBuffer<PirateRadioEnvelope>();

		const ctx: HandlerContext = {
			manager,
			store,
			loopManager,
			jobManager,
			client: {} as HandlerContext["client"],
			configDir: "config",
			startedAt: new Date().toISOString(),
			executingGoals: new Map(),
			claimedAccounts: new Set(),
			craftingEventsStore: new CraftingEventsStore(),
			combatEventsStore: createEventBuffer<CombatEnvelope>(),
			pirateRadioStore,
			combatModeStore: { get: () => "flee" } as unknown as CombatModeStore,
		};

		// Serve the daemon's real route table rather than re-declaring a subset
		// here — a handler registered at the wrong path is then a failure in
		// these tests instead of a silent 404 in production.
		server = Bun.serve({
			port: 0, // random available port
			routes: buildRoutes(ctx),
			fetch: () => errorResponse("Not found", 404),
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

	test("GET /accounts/:playerId/pirate-radio/events is served as an SSE stream", async () => {
		// Proves the route is registered at the path the client and docs use —
		// a handler wired at the wrong path would 404 here rather than in
		// production.
		// Seeded so the stream writes a frame — a stream that never flushes a
		// byte leaves the response headers unsent.
		pirateRadioStore.record("p1", {
			receivedAt: new Date().toISOString(),
			event: makePirateRadioEvent(),
		});

		const controller = new AbortController();
		const res = await fetch(`${base}/accounts/p1/pirate-radio/events`, {
			signal: controller.signal,
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		controller.abort();
	});

	test("POST /accounts/:playerId/fleet is wired to the ensure-fleet handler", async () => {
		// Route paths are not guessable from handler names, so this asserts the
		// path itself against the real route table rather than 404ing live.
		const res = await fetch(`${base}/accounts/p1/fleet`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ members: [] }),
		});
		expect(res.status).not.toBe(404);
	});

	test("POST /accounts/:playerId/fleet rejects a body without members", async () => {
		const res = await fetch(`${base}/accounts/p1/fleet`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("members");
	});

	test("POST /accounts/:playerId/fleet returns 404 for an unknown account", async () => {
		const res = await fetch(`${base}/accounts/nope/fleet`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ members: [] }),
		});
		expect(res.status).toBe(404);
	});

	test("POST /goals/batch is wired and keys results by player id", async () => {
		const res = await fetch(`${base}/goals/batch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ playerIds: ["p1"], type: "ensure-undocked", options: {} }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			accounts: Record<string, unknown>;
			summary: { total: number };
		};
		expect(body.summary.total).toBe(1);
		expect(Object.keys(body.accounts)).toEqual(["p1"]);
	});

	test("POST /goals/batch reports an unknown account rather than failing the batch", async () => {
		const res = await fetch(`${base}/goals/batch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ playerIds: ["p1", "ghost"], type: "ensure-undocked", options: {} }),
		});
		const body = (await res.json()) as { accounts: Record<string, { message: string }> };
		expect(body.accounts["ghost"]?.message).toBe("not_connected");
		expect(body.accounts["p1"]).toBeDefined();
	});

	test("POST /goals/batch rejects a missing playerIds", async () => {
		const res = await fetch(`${base}/goals/batch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: "ensure-undocked" }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toContain("playerIds");
	});

	test("POST /accounts/:playerId/combat-heartbeat is wired and acknowledges", async () => {
		const res = await fetch(`${base}/accounts/p1/combat-heartbeat`, { method: "POST" });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { playerId: string }).playerId).toBe("p1");
	});

	test("GET /accounts/:playerId/battle-log/events is served as an SSE stream", async () => {
		const controller = new AbortController();
		const res = await fetch(`${base}/accounts/p1/battle-log/events?battleId=b-1`, {
			signal: controller.signal,
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		controller.abort();
	});

	test("GET /accounts/:playerId/battle-log/events 404s for an unknown account", async () => {
		const res = await fetch(`${base}/accounts/nope/battle-log/events`);
		expect(res.status).toBe(404);
	});

	test("unknown routes return 404", async () => {
		const res = await fetch(`${base}/nonexistent`);
		expect(res.status).toBe(404);
	});

	test("wrong method returns 404", async () => {
		const res = await fetch(`${base}/health`, { method: "DELETE" });
		expect(res.status).toBe(404);
	});

	test("a throwing handler returns 500 rather than escaping to Bun", async () => {
		const res = await fetch(`${base}/accounts/p1/state/queue`);
		const body = (await res.json()) as Record<string, unknown>;

		expect(res.status).toBe(500);
		expect(body["error"]).toBe("Internal server error");
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
