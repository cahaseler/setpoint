import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountConfig } from "../../src/accounts/config.js";
import { AccountManager } from "../../src/accounts/manager.js";
import { SpaceMoltClient } from "../../src/api/client.js";
import type { AccountCredentials } from "../../src/api/session.js";
import {
	createMockFetch,
	makeLoginResponse,
	makeSessionResponse,
} from "../fixtures/api-responses.js";

/** Small delay for queue processing to complete in tests. */
function waitForQueue(ms = 50): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Build mock responses for N account connections (session create + login each). */
function buildConnectResponses(count: number): Array<{ status: number; body: unknown }> {
	const responses: Array<{ status: number; body: unknown }> = [];
	for (let i = 0; i < count; i++) {
		responses.push({ status: 200, body: makeSessionResponse(`sess-${i}`) });
		responses.push({ status: 200, body: makeLoginResponse() });
	}
	return responses;
}

const CONFIG_TEMP_DIR = join(import.meta.dir, "../../test-config-temp");

describe("AccountManager queue", () => {
	let manager: AccountManager | undefined;

	afterEach(() => {
		manager?.disconnectAll();
		manager = undefined;

		// Clean up temp config directory
		if (existsSync(CONFIG_TEMP_DIR)) {
			rmSync(CONFIG_TEMP_DIR, { recursive: true });
		}
	});

	function makeClient(
		responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
	): { client: SpaceMoltClient; mockFetch: ReturnType<typeof createMockFetch> } {
		const mockFetch = createMockFetch(responses);
		const client = new SpaceMoltClient({
			baseUrl: "https://test.spacemolt.com",
			fetch: mockFetch,
		});
		return { client, mockFetch };
	}

	describe("queue management", () => {
		test("queueAccount adds to pending queue and returns PendingAccount", () => {
			const { client } = makeClient([]);
			manager = new AccountManager(client, {
				staggerDelayMs: 10,
				keepaliveIntervalMs: 60_000,
			});

			const config: AccountConfig = { username: "Player1", password: "pw1", player_id: "id-1" };
			const pending = manager.queueAccount(config);

			// processQueue fires synchronously via void promise, so the status
			// may already be "connecting" by the time queueAccount returns.
			expect(["pending", "connecting"]).toContain(pending.status);
			expect(pending.username).toBe("Player1");
			expect(pending.playerId).toBe("id-1");
			expect(pending.config).toEqual(config);
			expect(pending.queuedAt).toBeDefined();
			expect(manager.getAllPending()).toHaveLength(1);
		});

		test("queueByCredentials adds to pending queue and returns PendingAccount, no playerId", () => {
			const { client } = makeClient([]);
			manager = new AccountManager(client, {
				staggerDelayMs: 10,
				keepaliveIntervalMs: 60_000,
			});

			const credentials: AccountCredentials = { username: "Player1", password: "pw1" };
			const pending = manager.queueByCredentials(credentials);

			// processQueue fires synchronously via void promise, so the status
			// may already be "connecting" by the time queueByCredentials returns.
			expect(["pending", "connecting"]).toContain(pending.status);
			expect(pending.username).toBe("Player1");
			expect(pending.playerId).toBeUndefined();
			expect(pending.config).toBeUndefined();
			expect(pending.queuedAt).toBeDefined();
			expect(manager.getAllPending()).toHaveLength(1);
		});

		test("queueAccount throws when player_id already connected", async () => {
			const { client } = makeClient(buildConnectResponses(1));
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			const config: AccountConfig = { username: "Player1", password: "pw1", player_id: "id-1" };
			await manager.connectAll([config]);

			expect(() => {
				manager?.queueAccount({ username: "Player1Again", password: "pw2", player_id: "id-1" });
			}).toThrow("Account already connected");
		});

		test("queueAccount throws when username already in pending queue", () => {
			const { client } = makeClient([]);
			manager = new AccountManager(client, {
				staggerDelayMs: 10,
				keepaliveIntervalMs: 60_000,
			});

			manager.queueAccount({ username: "Player1", password: "pw1", player_id: "id-1" });

			expect(() => {
				manager?.queueAccount({ username: "Player1", password: "pw2", player_id: "id-2" });
			}).toThrow("Account already queued");
		});

		test("queueByCredentials throws when username already connected", async () => {
			const { client } = makeClient(buildConnectResponses(1));
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			await manager.connectAll([{ username: "Player1", password: "pw1", player_id: "id-1" }]);

			expect(() => {
				manager?.queueByCredentials({ username: "Player1", password: "pw1" });
			}).toThrow("Account already connected");
		});

		test("queueByCredentials throws when username already in pending queue", () => {
			const { client } = makeClient([]);
			manager = new AccountManager(client, {
				staggerDelayMs: 10,
				keepaliveIntervalMs: 60_000,
			});

			manager.queueByCredentials({ username: "Player1", password: "pw1" });

			expect(() => {
				manager?.queueByCredentials({ username: "Player1", password: "pw2" });
			}).toThrow("Account already queued");
		});

		test("getPending returns pending account by username (case-insensitive)", () => {
			const { client } = makeClient([]);
			manager = new AccountManager(client, {
				staggerDelayMs: 10,
				keepaliveIntervalMs: 60_000,
			});

			manager.queueAccount({ username: "Player1", password: "pw1", player_id: "id-1" });

			expect(manager.getPending("Player1")).toBeDefined();
			expect(manager.getPending("player1")).toBeDefined();
			expect(manager.getPending("PLAYER1")).toBeDefined();
			expect(manager.getPending("Unknown")).toBeUndefined();
		});

		test("getPendingByPlayerId returns pending account by player_id", () => {
			const { client } = makeClient([]);
			manager = new AccountManager(client, {
				staggerDelayMs: 10,
				keepaliveIntervalMs: 60_000,
			});

			manager.queueAccount({ username: "Player1", password: "pw1", player_id: "id-1" });

			expect(manager.getPendingByPlayerId("id-1")).toBeDefined();
			expect(manager.getPendingByPlayerId("id-1")?.username).toBe("Player1");
			expect(manager.getPendingByPlayerId("id-999")).toBeUndefined();
		});

		test("getAllPending returns all pending accounts", () => {
			const { client } = makeClient([]);
			manager = new AccountManager(client, {
				staggerDelayMs: 10,
				keepaliveIntervalMs: 60_000,
			});

			manager.queueAccount({ username: "Player1", password: "pw1", player_id: "id-1" });
			manager.queueAccount({ username: "Player2", password: "pw2", player_id: "id-2" });

			const all = manager.getAllPending();
			expect(all).toHaveLength(2);
			expect(all.map((p) => p.username)).toEqual(["Player1", "Player2"]);
		});

		test("removePending removes entry and returns true", () => {
			const { client } = makeClient([]);
			manager = new AccountManager(client, {
				staggerDelayMs: 10,
				keepaliveIntervalMs: 60_000,
			});

			manager.queueAccount({ username: "Player1", password: "pw1", player_id: "id-1" });
			expect(manager.getAllPending()).toHaveLength(1);

			const removed = manager.removePending("Player1");
			expect(removed).toBe(true);
			expect(manager.getAllPending()).toHaveLength(0);
		});

		test("removePending returns false for unknown username", () => {
			const { client } = makeClient([]);
			manager = new AccountManager(client, {
				staggerDelayMs: 10,
				keepaliveIntervalMs: 60_000,
			});

			const removed = manager.removePending("Nobody");
			expect(removed).toBe(false);
		});

		test("disconnectAll clears the pending queue", () => {
			const { client } = makeClient([]);
			manager = new AccountManager(client, {
				staggerDelayMs: 10,
				keepaliveIntervalMs: 60_000,
			});

			manager.queueAccount({ username: "Player1", password: "pw1", player_id: "id-1" });
			manager.queueAccount({ username: "Player2", password: "pw2", player_id: "id-2" });
			expect(manager.getAllPending()).toHaveLength(2);

			manager.disconnectAll();
			expect(manager.getAllPending()).toHaveLength(0);
		});
	});

	describe("queue processing", () => {
		test("processQueue connects a queued account (pending -> connecting -> connected)", async () => {
			const { client } = makeClient(buildConnectResponses(1));
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			const config: AccountConfig = { username: "Player1", password: "pw1", player_id: "id-1" };
			const pending = manager.queueAccount(config);

			// processQueue fires synchronously, so status may already be "connecting"
			expect(["pending", "connecting"]).toContain(pending.status);

			// Wait for queue processing to complete
			await waitForQueue(200);

			expect(pending.status).toBe("connected");
			expect(manager.size).toBe(1);
			expect(manager.getByPlayerId("id-1")).toBeDefined();
		});

		test("processQueue sets status to failed with error message on connection failure", async () => {
			const { client } = makeClient([
				// Session creation returns 429 (rate limited)
				{ status: 429, headers: { "Retry-After": "60" } },
			]);
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			const config: AccountConfig = { username: "Player1", password: "pw1", player_id: "id-1" };
			const pending = manager.queueAccount(config);

			await waitForQueue(200);

			expect(pending.status).toBe("failed");
			expect(pending.error).toBeDefined();
			expect(typeof pending.error).toBe("string");
			expect(manager.size).toBe(0);
		});

		test("processQueue continues to next account after a failure", async () => {
			const responses = [
				// Account 1: session creation fails
				{ status: 429, headers: { "Retry-After": "60" } },
				// Account 2: success
				{ status: 200, body: makeSessionResponse("sess-1") },
				{ status: 200, body: makeLoginResponse() },
			] as Array<{ status: number; body?: unknown; headers?: Record<string, string> }>;

			const { client } = makeClient(responses);
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			const pending1 = manager.queueAccount({
				username: "Player1",
				password: "pw1",
				player_id: "id-1",
			});
			const pending2 = manager.queueAccount({
				username: "Player2",
				password: "pw2",
				player_id: "id-2",
			});

			await waitForQueue(300);

			expect(pending1.status).toBe("failed");
			expect(pending2.status).toBe("connected");
			expect(manager.size).toBe(1);
		});

		test("processQueue saves config to disk after successful connection when configDir is set", async () => {
			const { client } = makeClient(buildConnectResponses(1));
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
				configDir: CONFIG_TEMP_DIR,
			});

			const config: AccountConfig = { username: "Player1", password: "pw1", player_id: "id-1" };
			manager.queueAccount(config);

			await waitForQueue(200);

			const savedPath = join(CONFIG_TEMP_DIR, "accounts", "player1.json");
			expect(existsSync(savedPath)).toBe(true);

			const saved = JSON.parse(await readFile(savedPath, "utf-8"));
			expect(saved.username).toBe("Player1");
			expect(saved.password).toBe("pw1");
			expect(saved.player_id).toBe("id-1");
		});

		test("processQueue respects stagger delay between connections", async () => {
			const { client } = makeClient(buildConnectResponses(2));
			const delayMs = 100;
			manager = new AccountManager(client, {
				staggerDelayMs: delayMs,
				keepaliveIntervalMs: 60_000,
			});

			const start = Date.now();

			manager.queueAccount({ username: "Player1", password: "pw1", player_id: "id-1" });
			manager.queueAccount({ username: "Player2", password: "pw2", player_id: "id-2" });

			// Wait for both to finish (delay applies after each connection including the last)
			await waitForQueue(500);

			const elapsed = Date.now() - start;

			// Should have applied stagger delay at least twice (after each account)
			expect(elapsed).toBeGreaterThanOrEqual(delayMs * 2 - 20);

			expect(manager.size).toBe(2);
		});

		test("paces fallback logins through the auth limiter when stored-session resume fails", async () => {
			// Stored sessions look resumable, so connectAll skips its own stagger.
			// But resume validation (get_state) fails — e.g. the game server dropped
			// sessions during downtime — so each account falls back to a full login.
			// Those logins must still be paced by the shared auth limiter, otherwise a
			// whole fleet re-logs in at once and trips the auth rate limit / IP block.
			const farFuture = new Date(Date.now() + 60 * 60 * 1000);
			const stateStore = {
				getSessionInfo: () => ({ sessionId: "stale-sess", expiresAt: farFuture }),
				setSessionInfo: () => {},
			} as unknown as import("../../src/state/store.js").StateStore;

			const responses = [
				// Account 1: resume validation 401 → fallback login (session + login)
				{ status: 401, body: { error: { code: "session_expired", message: "expired" } } },
				{ status: 200, body: makeSessionResponse("sess-1") },
				{ status: 200, body: makeLoginResponse() },
				// Account 2: same
				{ status: 401, body: { error: { code: "session_expired", message: "expired" } } },
				{ status: 200, body: makeSessionResponse("sess-2") },
				{ status: 200, body: makeLoginResponse() },
			] as Array<{ status: number; body?: unknown; headers?: Record<string, string> }>;

			const { client } = makeClient(responses);
			const delayMs = 80;
			manager = new AccountManager(client, {
				staggerDelayMs: delayMs,
				keepaliveIntervalMs: 60_000,
				stateStore,
			});

			const start = Date.now();
			const connected = await manager.connectAll([
				{ username: "Player1", password: "pw1", player_id: "id-1" },
				{ username: "Player2", password: "pw2", player_id: "id-2" },
			]);
			const elapsed = Date.now() - start;

			// Both reconnected despite resume failing
			expect(connected).toHaveLength(2);
			expect(manager.size).toBe(2);
			// The second login waited on the auth limiter even though connectAll
			// skipped its own stagger (likelyResume was true).
			expect(elapsed).toBeGreaterThanOrEqual(delayMs - 20);
		});

		test("onAccountConnected fires after queueAccount connects", async () => {
			const { client } = makeClient(buildConnectResponses(1));
			const connected: string[] = [];
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
				onAccountConnected: (playerId) => connected.push(playerId),
			});

			manager.queueAccount({ username: "Player1", password: "pw1", player_id: "id-1" });
			await waitForQueue(200);

			expect(connected).toEqual(["id-1"]);
		});

		test("setOnAccountConnected fires after queueAccount connects", async () => {
			const { client } = makeClient(buildConnectResponses(1));
			const connected: string[] = [];
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});
			manager.setOnAccountConnected((playerId) => connected.push(playerId));

			manager.queueAccount({ username: "Player1", password: "pw1", player_id: "id-1" });
			await waitForQueue(200);

			expect(connected).toEqual(["id-1"]);
		});

		test("onAccountConnected fires for each account in queue", async () => {
			const { client } = makeClient(buildConnectResponses(2));
			const connected: string[] = [];
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
				onAccountConnected: (playerId) => connected.push(playerId),
			});

			manager.queueAccount({ username: "Player1", password: "pw1", player_id: "id-1" });
			manager.queueAccount({ username: "Player2", password: "pw2", player_id: "id-2" });
			await waitForQueue(300);

			expect(connected).toHaveLength(2);
			expect(connected).toContain("id-1");
			expect(connected).toContain("id-2");
		});

		test("onAccountConnected does not fire for connectAll", async () => {
			const responses = buildConnectResponses(1);
			const { client } = makeClient(responses);
			const connected: string[] = [];
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
				onAccountConnected: (playerId) => connected.push(playerId),
			});

			await manager.connectAll([{ username: "Player1", password: "pw1", player_id: "id-1" }]);

			// connectAll does not fire onAccountConnected — callers handle resumption themselves
			expect(connected).toHaveLength(0);
		});
	});
});
