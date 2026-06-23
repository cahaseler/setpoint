import { afterEach, describe, expect, mock, test } from "bun:test";
import { SpaceMoltClient } from "../../src/api/client.js";
import { Session } from "../../src/api/session.js";
import { RateLimitError } from "../../src/util/errors.js";
import {
	createMockFetch,
	makeErrorResponse,
	makeGameStateContent,
	makeLoginResponse,
	makeSessionResponse,
	makeV2Response,
} from "../fixtures/api-responses.js";

describe("Session", () => {
	const credentials = { username: "TestPlayer", password: "secret123" };

	/** Keep track of sessions to clean up timers. */
	const activeSessions: Session[] = [];
	afterEach(() => {
		for (const session of activeSessions) {
			session.disconnect();
		}
		activeSessions.length = 0;
	});

	function createSession(
		responses: Parameters<typeof createMockFetch>[0],
		options: {
			keepaliveIntervalMs?: number;
			actionInProgressWaitMs?: number;
			maxActionInProgressRetries?: number;
			authSlot?: { acquire(): Promise<void> };
		} = {},
	): { session: Session; mockFetch: ReturnType<typeof createMockFetch> } {
		const mockFetch = createMockFetch(responses);
		const client = new SpaceMoltClient({
			baseUrl: "https://test.spacemolt.com",
			fetch: mockFetch,
		});
		const session = new Session(client, credentials, {
			keepaliveIntervalMs: options.keepaliveIntervalMs ?? 60_000,
			actionInProgressWaitMs: options.actionInProgressWaitMs ?? 0,
			...(options.maxActionInProgressRetries !== undefined
				? { maxActionInProgressRetries: options.maxActionInProgressRetries }
				: {}),
			...(options.authSlot ? { authSlot: options.authSlot } : {}),
		});
		activeSessions.push(session);
		return { session, mockFetch };
	}

	describe("connect", () => {
		test("creates session, logs in, and transitions to active", async () => {
			const { session, mockFetch } = createSession([
				{ status: 200, body: makeSessionResponse("sess-1") },
				{ status: 200, body: makeLoginResponse() },
			]);

			expect(session.state).toBe("disconnected");

			const loginResponse = await session.connect();

			expect(session.state).toBe("active");
			expect(session.sessionId).toBe("test-session-id");
			expect(session.info?.playerId).toBe("test-player-id");
			expect(loginResponse.message).toBe("Welcome back, TestPlayer!");
			expect(loginResponse.player.username).toBe("TestPlayer");

			// Should have made 2 calls: createSession + login
			expect(mockFetch.calls).toHaveLength(2);
			expect(mockFetch.calls[0]?.url).toContain("/session");
			expect(mockFetch.calls[1]?.url).toContain("/spacemolt_auth/login");
		});

		test("sends correct credentials in login request", async () => {
			const { session, mockFetch } = createSession([
				{ status: 200, body: makeSessionResponse() },
				{ status: 200, body: makeLoginResponse() },
			]);

			await session.connect();

			const loginCall = mockFetch.calls[1];
			const body = JSON.parse(loginCall?.init?.body as string) as Record<string, unknown>;
			expect(body["username"]).toBe("TestPlayer");
			expect(body["password"]).toBe("secret123");
		});

		test("transitions to disconnected on failure", async () => {
			const { session } = createSession([{ status: 429, headers: { "Retry-After": "60" } }]);

			await expect(session.connect()).rejects.toThrow(RateLimitError);
			expect(session.state).toBe("disconnected");
		});

		test("throws when session creation returns no session ID", async () => {
			const noSessionResponse = makeV2Response();
			noSessionResponse.session = { id: undefined, player_id: undefined } as unknown as NonNullable<
				typeof noSessionResponse.session
			>;
			const { session } = createSession([{ status: 200, body: noSessionResponse }]);

			await expect(session.connect()).rejects.toThrow("Session creation returned no session ID");
			expect(session.state).toBe("disconnected");
		});
	});

	describe("execute", () => {
		test("sends game action through active session", async () => {
			const gameStateContent = makeGameStateContent();
			const { session, mockFetch } = createSession([
				{ status: 200, body: makeSessionResponse() },
				{ status: 200, body: makeLoginResponse() },
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);

			await session.connect();
			const _result = await session.execute("spacemolt", "get_state");

			expect(mockFetch.calls).toHaveLength(3);
			expect(mockFetch.calls[2]?.url).toContain("/spacemolt/get_state");

			const headers = mockFetch.calls[2]?.init?.headers as Record<string, string>;
			expect(headers["X-Session-Id"]).toBe("test-session-id");
		});

		test("throws when no active session", async () => {
			const { session } = createSession([]);

			await expect(session.execute("spacemolt", "get_state")).rejects.toThrow("No active session");
		});

		test("unwraps the action result from `details` and feeds the full envelope to the updater", async () => {
			const gameStateContent = makeGameStateContent();
			const actionResult = {
				item_id: "ore_iron",
				item_name: "Iron Ore",
				quantity: 5,
				message: "Jettisoned 5x Iron Ore",
			};
			const wrapped = { ...gameStateContent, details: actionResult };
			const { session } = createSession([
				{ status: 200, body: makeSessionResponse() },
				{ status: 200, body: makeLoginResponse() },
				{
					status: 200,
					body: makeV2Response({
						structuredContent: wrapped as unknown as Record<string, never>,
					}),
				},
			]);

			const seen: unknown[] = [];
			session.onResponse((sc) => seen.push(sc));

			await session.connect();
			const result = await session.execute("spacemolt", "jettison", {
				id: "ore_iron",
				quantity: 5,
			});

			// Caller receives the unwrapped action result (the pre-`details` contract).
			expect(result.structuredContent).toEqual(actionResult);
			// The state updater saw the FULL envelope (state + details), so the store stays fresh.
			expect(seen[seen.length - 1]).toEqual(wrapped);
		});

		test("retries once after action_in_progress and returns success", async () => {
			const gameStateContent = makeGameStateContent();
			const { session, mockFetch } = createSession([
				{ status: 200, body: makeSessionResponse() },
				{ status: 200, body: makeLoginResponse() },
				// First attempt: action_in_progress
				{ status: 200, body: makeErrorResponse("action_in_progress", "Action in progress") },
				// Retry succeeds
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);

			await session.connect();
			const result = await session.execute("spacemolt", "get_state");

			// 2 (connect) + 1 (failed) + 1 (retry) = 4
			expect(mockFetch.calls).toHaveLength(4);
			expect(result.structuredContent).toEqual(gameStateContent);
		});

		test("propagates error when action_in_progress retry also fails", async () => {
			const { session, mockFetch } = createSession([
				{ status: 200, body: makeSessionResponse() },
				{ status: 200, body: makeLoginResponse() },
				// First attempt: action_in_progress
				{ status: 200, body: makeErrorResponse("action_in_progress", "Action in progress") },
				// Retry also fails with a different error
				{ status: 200, body: makeErrorResponse("server_error", "Something went wrong") },
			]);

			await session.connect();
			await expect(session.execute("spacemolt", "craft", { id: "recipe_1" })).rejects.toThrow(
				"Something went wrong",
			);
			expect(mockFetch.calls).toHaveLength(4);
		});

		test("retries multiple times on persistent action_in_progress before succeeding", async () => {
			const gameStateContent = makeGameStateContent();
			const { session, mockFetch } = createSession([
				{ status: 200, body: makeSessionResponse() },
				{ status: 200, body: makeLoginResponse() },
				// Initial attempt + 2 more polls: all action_in_progress (long travel)
				{ status: 200, body: makeErrorResponse("action_in_progress", "Action in progress") },
				{ status: 200, body: makeErrorResponse("action_in_progress", "Action in progress") },
				{ status: 200, body: makeErrorResponse("action_in_progress", "Action in progress") },
				// Travel complete — success
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);

			await session.connect();
			const result = await session.execute("spacemolt", "travel", { id: "sol" });

			// 2 (connect) + 1 (fail) + 3 (retries, last succeeds) = 6
			expect(mockFetch.calls).toHaveLength(6);
			expect(result.structuredContent).toEqual(gameStateContent);
		});

		test("retries after in_transit and returns success", async () => {
			const gameStateContent = makeGameStateContent();
			const { session, mockFetch } = createSession([
				{ status: 200, body: makeSessionResponse() },
				{ status: 200, body: makeLoginResponse() },
				// Ship mid-jump (e.g. reconnect after a dropped connection): poll until arrival
				{
					status: 200,
					body: makeErrorResponse("in_transit", "Your ship is mid-jump to Sol (~20s)"),
				},
				{
					status: 200,
					body: makeErrorResponse("in_transit", "Your ship is mid-jump to Sol (~10s)"),
				},
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);

			await session.connect();
			const result = await session.execute("spacemolt", "dock", { id: "station-1" });

			// 2 (connect) + 1 (fail) + 2 (retries, last succeeds) = 5
			expect(mockFetch.calls).toHaveLength(5);
			expect(result.structuredContent).toEqual(gameStateContent);
		});

		test("throws action_in_progress after exhausting all retries", async () => {
			// Use maxActionInProgressRetries: 2 so the test only needs 4 mock responses
			const { session, mockFetch } = createSession(
				[
					{ status: 200, body: makeSessionResponse() },
					{ status: 200, body: makeLoginResponse() },
					// Initial + 2 retry polls: all action_in_progress → retries exhausted
					{ status: 200, body: makeErrorResponse("action_in_progress", "Action in progress") },
					{ status: 200, body: makeErrorResponse("action_in_progress", "Action in progress") },
					{ status: 200, body: makeErrorResponse("action_in_progress", "Action in progress") },
				],
				{ maxActionInProgressRetries: 2 },
			);

			await session.connect();
			await expect(session.execute("spacemolt", "travel", { id: "sol" })).rejects.toMatchObject({
				code: "action_in_progress",
			});

			// 2 (connect) + 1 (fail) + 2 (retries, both fail) = 5
			expect(mockFetch.calls).toHaveLength(5);
		});

		test("waits Retry-After when rate limited and retries once", async () => {
			const gameStateContent = makeGameStateContent();
			const { session, mockFetch } = createSession([
				{ status: 200, body: makeSessionResponse() },
				{ status: 200, body: makeLoginResponse() },
				// First attempt: rate limited (Retry-After: 0 to avoid delay in tests)
				{ status: 429, headers: { "Retry-After": "0" } },
				// Retry succeeds
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);

			await session.connect();
			const result = await session.execute("spacemolt", "get_state");

			// 2 (connect) + 1 (rate limited) + 1 (retry) = 4
			expect(mockFetch.calls).toHaveLength(4);
			expect(result.structuredContent).toEqual(gameStateContent);
		});
	});

	describe("session recovery", () => {
		test("recovers from 401 by reconnecting and retrying", async () => {
			const gameStateContent = makeGameStateContent();
			const { session, mockFetch } = createSession([
				// Initial connect
				{ status: 200, body: makeSessionResponse("sess-1") },
				{ status: 200, body: makeLoginResponse() },
				// Execute fails with 401
				{ status: 401 },
				// Recovery: new session + login
				{ status: 200, body: makeSessionResponse("sess-2") },
				{ status: 200, body: makeLoginResponse() },
				// Retry succeeds
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);

			await session.connect();
			const result = await session.execute("spacemolt", "get_state");

			// 2 (initial connect) + 1 (failed) + 2 (recovery connect) + 1 (retry) = 6
			expect(mockFetch.calls).toHaveLength(6);
			expect(result.structuredContent).toEqual(gameStateContent);
		});

		test("recovers from an in-body not_authenticated error (game logout, not a 401)", async () => {
			const gameStateContent = makeGameStateContent();
			const { session, mockFetch } = createSession([
				// Initial connect
				{ status: 200, body: makeSessionResponse("sess-1") },
				{ status: 200, body: makeLoginResponse() },
				// Execute fails: game returns not_authenticated in the body (HTTP 200),
				// as after a server restart drops logins — "You must be logged in".
				{ status: 200, body: makeErrorResponse("not_authenticated", "You must be logged in") },
				// Recovery: new session + login
				{ status: 200, body: makeSessionResponse("sess-2") },
				{ status: 200, body: makeLoginResponse() },
				// Retry succeeds
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);

			await session.connect();
			const result = await session.execute("spacemolt", "mine");

			// 2 (connect) + 1 (not_authenticated) + 2 (recovery) + 1 (retry) = 6
			expect(mockFetch.calls).toHaveLength(6);
			expect(result.structuredContent).toEqual(gameStateContent);
		});

		test("retries recovery when connect itself fails with 401", async () => {
			const gameStateContent = makeGameStateContent();
			const { session, mockFetch } = createSession([
				// Initial connect
				{ status: 200, body: makeSessionResponse("sess-1") },
				{ status: 200, body: makeLoginResponse() },
				// Execute fails with 401
				{ status: 401 },
				// Recovery attempt 1: session created but login fails with 401
				{ status: 200, body: makeSessionResponse("sess-2") },
				{ status: 401 },
				// Recovery attempt 2: success
				{ status: 200, body: makeSessionResponse("sess-3") },
				{ status: 200, body: makeLoginResponse() },
				// Retry succeeds
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);

			await session.connect();
			const result = await session.execute("spacemolt", "get_state");

			// 2 (connect) + 1 (fail) + 2 (recover attempt 1, login 401) + 2 (recover attempt 2) + 1 (retry) = 8
			expect(mockFetch.calls).toHaveLength(8);
			expect(result.structuredContent).toEqual(gameStateContent);
		});

		test("acquires auth slot before each recovery connect attempt", async () => {
			const gameStateContent = makeGameStateContent();
			const acquireMock = mock(async () => {});
			const { session, mockFetch } = createSession(
				[
					// Initial connect
					{ status: 200, body: makeSessionResponse("sess-1") },
					{ status: 200, body: makeLoginResponse() },
					// Execute fails with 401
					{ status: 401 },
					// Recovery: session + login
					{ status: 200, body: makeSessionResponse("sess-2") },
					{ status: 200, body: makeLoginResponse() },
					// Retry succeeds
					{
						status: 200,
						body: makeV2Response({
							structuredContent: gameStateContent as unknown as Record<string, never>,
						}),
					},
				],
				{ authSlot: { acquire: acquireMock } },
			);

			await session.connect();
			await session.execute("spacemolt", "get_state");

			// acquire() should be called once: one recovery connect attempt
			expect(acquireMock).toHaveBeenCalledTimes(1);
			expect(mockFetch.calls).toHaveLength(6);
		});

		test("waits Retry-After during recovery without consuming a recovery attempt", async () => {
			const gameStateContent = makeGameStateContent();
			const { session, mockFetch } = createSession([
				// Initial connect
				{ status: 200, body: makeSessionResponse("sess-1") },
				{ status: 200, body: makeLoginResponse() },
				// Execute fails with 401
				{ status: 401 },
				// Recovery: session creation is rate limited (Retry-After: 0 to avoid delay)
				{ status: 429, headers: { "Retry-After": "0" } },
				// Recovery: retry after wait — succeeds
				{ status: 200, body: makeSessionResponse("sess-2") },
				{ status: 200, body: makeLoginResponse() },
				// Action retry succeeds
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);

			await session.connect();
			const result = await session.execute("spacemolt", "get_state");

			// 2 (connect) + 1 (401) + 1 (429 during recovery) + 2 (recovery) + 1 (retry) = 7
			expect(mockFetch.calls).toHaveLength(7);
			expect(result.structuredContent).toEqual(gameStateContent);
		});

		test("concurrent 401s share a single recovery", async () => {
			const gameStateContent = makeGameStateContent();
			const { session, mockFetch } = createSession([
				// Initial connect
				{ status: 200, body: makeSessionResponse("sess-1") },
				{ status: 200, body: makeLoginResponse() },
				// Two concurrent calls both fail with 401
				{ status: 401 },
				{ status: 401 },
				// Single recovery: session + login
				{ status: 200, body: makeSessionResponse("sess-2") },
				{ status: 200, body: makeLoginResponse() },
				// Both retries succeed
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);

			await session.connect();

			// Fire two concurrent execute calls
			const [result1, result2] = await Promise.all([
				session.execute("spacemolt", "get_state"),
				session.execute("spacemolt", "get_cargo"),
			]);

			expect(result1.structuredContent).toEqual(gameStateContent);
			expect(result2.structuredContent).toEqual(gameStateContent);
			// Should only have one recovery (not two)
			// 2 (connect) + 2 (both fail) + 2 (single recovery) + 2 (both retry) = 8
			expect(mockFetch.calls).toHaveLength(8);
		});
	});

	describe("disconnect", () => {
		test("clears session state and stops keepalive", async () => {
			const { session } = createSession([
				{ status: 200, body: makeSessionResponse() },
				{ status: 200, body: makeLoginResponse() },
			]);

			await session.connect();
			expect(session.state).toBe("active");

			session.disconnect();
			expect(session.state).toBe("disconnected");
			expect(session.sessionId).toBeUndefined();
			expect(session.info).toBeUndefined();
		});
	});

	describe("tryResume", () => {
		test("returns true and sets state to active when get_state succeeds", async () => {
			const gameStateContent = makeGameStateContent();
			const { session } = createSession([
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);

			const futureExpiry = new Date(Date.now() + 20 * 60 * 1000);
			const result = await session.tryResume("old-sess-id", futureExpiry);

			expect(result).toBe(true);
			expect(session.state).toBe("active");
			expect(session.sessionId).toBe("old-sess-id");
		});

		test("fires onResponse and onSessionChanged callbacks on success", async () => {
			const gameStateContent = makeGameStateContent();
			const { session } = createSession([
				{
					status: 200,
					body: makeV2Response({
						structuredContent: gameStateContent as unknown as Record<string, never>,
					}),
				},
			]);

			const responseCalls: unknown[] = [];
			const sessionChangedCalls: Array<{ sessionId: string; expiresAt: Date }> = [];

			session.onResponse((content) => responseCalls.push(content));
			session.onSessionChanged((sid, exp) =>
				sessionChangedCalls.push({ sessionId: sid, expiresAt: exp }),
			);

			const futureExpiry = new Date(Date.now() + 20 * 60 * 1000);
			await session.tryResume("old-sess-id", futureExpiry);

			expect(responseCalls).toHaveLength(1);
			expect(sessionChangedCalls).toHaveLength(1);
			expect(sessionChangedCalls[0]?.sessionId).toBe("old-sess-id");
		});

		test("returns false when get_state returns 401", async () => {
			const { session } = createSession([{ status: 401 }]);

			const futureExpiry = new Date(Date.now() + 20 * 60 * 1000);
			const result = await session.tryResume("old-sess-id", futureExpiry);

			expect(result).toBe(false);
			expect(session.state).toBe("disconnected");
			expect(session.sessionId).toBeUndefined();
		});

		test("returns false immediately when expiresAt is within 2 minutes", async () => {
			const { session, mockFetch } = createSession([]);

			const almostExpired = new Date(Date.now() + 60 * 1000); // 1 minute from now
			const result = await session.tryResume("old-sess-id", almostExpired);

			expect(result).toBe(false);
			expect(mockFetch.calls).toHaveLength(0);
		});
	});

	describe("onSessionChanged", () => {
		test("connect fires onSessionChanged callback on success", async () => {
			const { session } = createSession([
				{ status: 200, body: makeSessionResponse("sess-1") },
				{ status: 200, body: makeLoginResponse() },
			]);

			const sessionChangedCalls: Array<{ sessionId: string; expiresAt: Date }> = [];
			session.onSessionChanged((sid, exp) =>
				sessionChangedCalls.push({ sessionId: sid, expiresAt: exp }),
			);

			await session.connect();

			expect(sessionChangedCalls).toHaveLength(1);
			expect(sessionChangedCalls[0]?.sessionId).toBe("test-session-id");
		});

		test("keepalivePoll fires onSessionChanged when response includes expires_at", async () => {
			const gameStateContent = makeGameStateContent();
			const { session } = createSession(
				[
					{ status: 200, body: makeSessionResponse() },
					{ status: 200, body: makeLoginResponse() },
					{
						status: 200,
						body: makeV2Response({
							structuredContent: gameStateContent as unknown as Record<string, never>,
							session: {
								id: "test-session-id",
								player_id: "test-player-id",
								created_at: "2026-02-19T00:00:00Z",
								expires_at: "2026-02-19T01:00:00Z",
							},
						}),
					},
				],
				{ keepaliveIntervalMs: 10 },
			);

			const sessionChangedCalls: string[] = [];
			session.onSessionChanged((sid) => sessionChangedCalls.push(sid));

			await session.connect();
			// connect() fires once; wait for keepalive to fire
			const initialCount = sessionChangedCalls.length;

			await new Promise((resolve) => setTimeout(resolve, 50));

			// Should have fired at least once more (from keepalive)
			expect(sessionChangedCalls.length).toBeGreaterThan(initialCount);
		});

		test("keepalivePoll uses the cheap get_queue query, not get_state", async () => {
			const { session, mockFetch } = createSession(
				[
					{ status: 200, body: makeSessionResponse() },
					{ status: 200, body: makeLoginResponse() },
					{
						status: 200,
						body: makeV2Response({
							structuredContent: makeGameStateContent() as unknown as Record<string, never>,
						}),
					},
				],
				{ keepaliveIntervalMs: 10 },
			);

			await session.connect();
			// connect() makes 2 calls (session + login); wait for keepalive to fire
			await new Promise((resolve) => setTimeout(resolve, 50));

			const keepaliveCall = mockFetch.calls[2];
			expect(keepaliveCall?.url).toContain("/spacemolt/get_queue");
			expect(keepaliveCall?.url).not.toContain("/spacemolt/get_state");
		});

		test("unsubscribe stops receiving callbacks", async () => {
			const { session } = createSession([
				{ status: 200, body: makeSessionResponse() },
				{ status: 200, body: makeLoginResponse() },
			]);

			const calls: string[] = [];
			const unsubscribe = session.onSessionChanged((sid) => calls.push(sid));
			unsubscribe();

			await session.connect();

			expect(calls).toHaveLength(0);
		});
	});

	describe("lastLoginResponse", () => {
		test("stores the most recent login response", async () => {
			const { session } = createSession([
				{ status: 200, body: makeSessionResponse() },
				{ status: 200, body: makeLoginResponse() },
			]);

			expect(session.lastLoginResponse).toBeUndefined();

			await session.connect();

			expect(session.lastLoginResponse).toBeDefined();
			expect(session.lastLoginResponse?.player.username).toBe("TestPlayer");
		});
	});
});
