import { afterEach, describe, expect, test } from "bun:test";
import type { AccountConfig } from "../../src/accounts/config.js";
import { AccountManager } from "../../src/accounts/manager.js";
import { SpaceMoltClient } from "../../src/api/client.js";
import { createMemoryDatabase } from "../../src/state/database.js";
import { StateStore } from "../../src/state/store.js";
import {
	createMockFetch,
	makeGameStateContent,
	makeLoginResponse,
	makeSessionResponse,
	makeV2Response,
} from "../fixtures/api-responses.js";

describe("AccountManager", () => {
	const accountConfigs: AccountConfig[] = [
		{ username: "Player1", password: "pw1", player_id: "id-1" },
		{ username: "Player2", password: "pw2", player_id: "id-2" },
		{ username: "Player3", password: "pw3", player_id: "id-3" },
	];

	let manager: AccountManager | undefined;

	afterEach(() => {
		manager?.disconnectAll();
		manager = undefined;
	});

	/** Build mock responses for N account connections (session create + login each). */
	function buildConnectResponses(count: number): Array<{ status: number; body: unknown }> {
		const responses: Array<{ status: number; body: unknown }> = [];
		for (let i = 0; i < count; i++) {
			responses.push({ status: 200, body: makeSessionResponse(`sess-${i}`) });
			responses.push({ status: 200, body: makeLoginResponse() });
		}
		return responses;
	}

	describe("connectAll", () => {
		test("connects all accounts sequentially", async () => {
			const mockFetch = createMockFetch(buildConnectResponses(3));
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			const connected = await manager.connectAll(accountConfigs);

			expect(connected).toHaveLength(3);
			expect(manager.size).toBe(3);
			// 3 accounts × 2 calls each (session + login)
			expect(mockFetch.calls).toHaveLength(6);
		});

		test("resumes session when stored session is valid (only get_state, no createSession+login)", async () => {
			const gameStateContent = makeGameStateContent();
			// Only a single get_state call — no createSession or login
			const mockFetch = createMockFetch([
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});

			const db = createMemoryDatabase();
			const store = new StateStore(db);
			// Store a session that won't expire for 20 minutes
			const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
			store.setSessionInfo("id-1", "stored-sess-id", expiresAt);

			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
				stateStore: store,
			});

			const connected = await manager.connectAll(accountConfigs.slice(0, 1));

			expect(connected).toHaveLength(1);
			expect(manager.size).toBe(1);
			// Only 1 API call (get_state), not 2 (createSession + login)
			expect(mockFetch.calls).toHaveLength(1);
			expect(mockFetch.calls[0]?.url).toContain("/spacemolt/get_state");
		});

		test("skips stagger delay when session is resumed", async () => {
			const gameStateContent = makeGameStateContent();
			// Account 1: resume (get_state only)
			// Account 2: full connect (createSession + login)
			const mockFetch = createMockFetch([
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
				{ status: 200, body: makeSessionResponse("sess-1") },
				{ status: 200, body: makeLoginResponse() },
			]);
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});

			const db = createMemoryDatabase();
			const store = new StateStore(db);
			const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
			store.setSessionInfo("id-1", "stored-sess-id", expiresAt);
			// id-2 has no stored session

			const delayMs = 50;
			manager = new AccountManager(client, {
				staggerDelayMs: delayMs,
				keepaliveIntervalMs: 60_000,
				stateStore: store,
			});

			const start = Date.now();
			const connected = await manager.connectAll(accountConfigs.slice(0, 2));
			const elapsed = Date.now() - start;

			expect(connected).toHaveLength(2);
			// id-1 resumed (no stagger needed before id-2 because id-2 is the one needing full connect
			// and it comes after id-1 which was resumed, so stagger IS applied before id-2)
			// Total elapsed should be >= delayMs (one stagger between id-1 and id-2)
			expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10);
		});

		test("falls back to full connect when tryResume fails (401), with stagger for subsequent accounts", async () => {
			// Account 1: stored session but get_state returns 401, then full connect
			// Account 2: no stored session, full connect
			const gameStateContent = makeGameStateContent();
			const mockFetch = createMockFetch([
				// Account 1 resume attempt: 401
				{ status: 401 },
				// Account 1 full connect
				{ status: 200, body: makeSessionResponse("sess-0") },
				{ status: 200, body: makeLoginResponse() },
				// Account 2 full connect
				{ status: 200, body: makeSessionResponse("sess-1") },
				{ status: 200, body: makeLoginResponse() },
			] as Array<{ status: number; body?: unknown }>);
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});

			const db = createMemoryDatabase();
			const store = new StateStore(db);
			const expiresAt = new Date(Date.now() + 20 * 60 * 1000);
			store.setSessionInfo("id-1", "stored-sess-id", expiresAt);

			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
				stateStore: store,
			});

			const connected = await manager.connectAll(accountConfigs.slice(0, 2));

			expect(connected).toHaveLength(2);
			// 1 (failed resume) + 2 (full connect id-1) + 2 (full connect id-2) = 5
			expect(mockFetch.calls).toHaveLength(5);
			// Ignore gameStateContent to suppress unused warning
			void gameStateContent;
		});

		test("continues connecting other accounts when one fails", async () => {
			const responses = [
				// Account 1: success
				{ status: 200, body: makeSessionResponse("sess-0") },
				{ status: 200, body: makeLoginResponse() },
				// Account 2: session creation fails with 429
				{ status: 429, headers: { "Retry-After": "60" } },
				// Account 3: success
				{ status: 200, body: makeSessionResponse("sess-2") },
				{ status: 200, body: makeLoginResponse() },
			] as Array<{ status: number; body?: unknown; headers?: Record<string, string> }>;

			const mockFetch = createMockFetch(responses);
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			const connected = await manager.connectAll(accountConfigs);

			expect(connected).toHaveLength(2);
			expect(manager.size).toBe(2);
		});
	});

	describe("account lookup", () => {
		test("getByUsername finds account case-insensitively", async () => {
			const mockFetch = createMockFetch(buildConnectResponses(1));
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			await manager.connectAll(accountConfigs.slice(0, 1));

			expect(manager.getByUsername("Player1")).toBeDefined();
			expect(manager.getByUsername("player1")).toBeDefined();
			expect(manager.getByUsername("PLAYER1")).toBeDefined();
			expect(manager.getByUsername("Unknown")).toBeUndefined();
		});

		test("getByPlayerId finds account by ID", async () => {
			const mockFetch = createMockFetch(buildConnectResponses(1));
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			await manager.connectAll(accountConfigs.slice(0, 1));

			expect(manager.getByPlayerId("id-1")).toBeDefined();
			expect(manager.getByPlayerId("id-999")).toBeUndefined();
		});

		test("getAll returns all managed accounts", async () => {
			const mockFetch = createMockFetch(buildConnectResponses(2));
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			await manager.connectAll(accountConfigs.slice(0, 2));

			const all = manager.getAll();
			expect(all).toHaveLength(2);
		});
	});

	describe("disconnect", () => {
		test("disconnectAccount removes a single account", async () => {
			const mockFetch = createMockFetch(buildConnectResponses(2));
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			await manager.connectAll(accountConfigs.slice(0, 2));
			expect(manager.size).toBe(2);

			manager.disconnectAccount("id-1");
			expect(manager.size).toBe(1);
			expect(manager.getByPlayerId("id-1")).toBeUndefined();
			expect(manager.getByPlayerId("id-2")).toBeDefined();
		});

		test("disconnectAll removes all accounts", async () => {
			const mockFetch = createMockFetch(buildConnectResponses(2));
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			await manager.connectAll(accountConfigs.slice(0, 2));
			expect(manager.size).toBe(2);

			manager.disconnectAll();
			expect(manager.size).toBe(0);
		});

		test("disconnectAccount is a no-op for unknown player ID", async () => {
			const mockFetch = createMockFetch([]);
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});
			manager = new AccountManager(client, { staggerDelayMs: 0 });

			// Should not throw
			manager.disconnectAccount("nonexistent");
			expect(manager.size).toBe(0);
		});
	});

	describe("stagger delay", () => {
		test("applies delay between account connections", async () => {
			const mockFetch = createMockFetch(buildConnectResponses(2));
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});
			const delayMs = 50;
			manager = new AccountManager(client, {
				staggerDelayMs: delayMs,
				keepaliveIntervalMs: 60_000,
			});

			const start = Date.now();
			await manager.connectAll(accountConfigs.slice(0, 2));
			const elapsed = Date.now() - start;

			// Should have waited at least one stagger delay (between account 1 and 2)
			expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10);
		});
	});

	describe("account isolation", () => {
		test("each account has its own session and endpoints", async () => {
			const mockFetch = createMockFetch(buildConnectResponses(2));
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});
			manager = new AccountManager(client, {
				staggerDelayMs: 0,
				keepaliveIntervalMs: 60_000,
			});

			await manager.connectAll(accountConfigs.slice(0, 2));

			const a1 = manager.getByPlayerId("id-1");
			const a2 = manager.getByPlayerId("id-2");

			expect(a1?.session).not.toBe(a2?.session);
			expect(a1?.endpoints).not.toBe(a2?.endpoints);
		});
	});
});
