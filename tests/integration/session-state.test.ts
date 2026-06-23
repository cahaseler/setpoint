import { afterEach, describe, expect, test } from "bun:test";
import { AccountManager } from "../../src/accounts/manager.js";
import { SpaceMoltClient } from "../../src/api/client.js";
import { Session } from "../../src/api/session.js";
import { createMemoryDatabase } from "../../src/state/database.js";
import { StateStore } from "../../src/state/store.js";
import { StateUpdater } from "../../src/state/updater.js";
import type { StateChangeEvent } from "../../src/state/updater.js";
import {
	createMockFetch,
	makeGameStateContent,
	makeLoginResponse,
	makeSessionResponse,
	makeV2Response,
} from "../fixtures/api-responses.js";

const credentials = { username: "TestPlayer", password: "secret123" };

describe("Session response callbacks", () => {
	const activeSessions: Session[] = [];
	afterEach(() => {
		for (const session of activeSessions) {
			session.disconnect();
		}
		activeSessions.length = 0;
	});

	function createSession(responses: Parameters<typeof createMockFetch>[0]): {
		session: Session;
		mockFetch: ReturnType<typeof createMockFetch>;
	} {
		const mockFetch = createMockFetch(responses);
		const client = new SpaceMoltClient({
			baseUrl: "https://test.spacemolt.com",
			fetch: mockFetch,
		});
		const session = new Session(client, credentials, {
			keepaliveIntervalMs: 60_000,
		});
		activeSessions.push(session);
		return { session, mockFetch };
	}

	test("onResponse fires after execute()", async () => {
		const gameState = makeGameStateContent();
		const { session } = createSession([
			{ status: 200, body: makeSessionResponse() },
			{ status: 200, body: makeLoginResponse() },
			{
				status: 200,
				body: makeV2Response({ structuredContent: gameState as unknown as Record<string, never> }),
			},
		]);

		await session.connect();

		const received: unknown[] = [];
		session.onResponse((content) => {
			received.push(content);
		});

		await session.execute("spacemolt", "get_state");

		expect(received).toHaveLength(1);
		const content = received[0] as Record<string, unknown>;
		expect(content["player"]).toBeDefined();
	});

	test("onResponse fires after session recovery", async () => {
		const gameState = makeGameStateContent();
		const { session } = createSession([
			// Initial connect
			{ status: 200, body: makeSessionResponse("sess-1") },
			{ status: 200, body: makeLoginResponse() },
			// execute → 401 (expired)
			{ status: 401 },
			// Recovery: create session + login
			{ status: 200, body: makeSessionResponse("sess-2") },
			{ status: 200, body: makeLoginResponse() },
			// Retry the original action
			{
				status: 200,
				body: makeV2Response({ structuredContent: gameState as unknown as Record<string, never> }),
			},
		]);

		await session.connect();

		const received: unknown[] = [];
		session.onResponse((content) => {
			received.push(content);
		});

		await session.execute("spacemolt", "get_state");

		// Should receive the successful retry response
		expect(received).toHaveLength(1);
	});

	test("unsubscribe stops callback", async () => {
		const { session } = createSession([
			{ status: 200, body: makeSessionResponse() },
			{ status: 200, body: makeLoginResponse() },
			{ status: 200, body: makeV2Response() },
			{ status: 200, body: makeV2Response() },
		]);

		await session.connect();

		const received: unknown[] = [];
		const unsub = session.onResponse((content) => {
			received.push(content);
		});

		await session.execute("spacemolt", "get_state");
		expect(received).toHaveLength(1);

		unsub();

		await session.execute("spacemolt", "get_state");
		expect(received).toHaveLength(1);
	});

	test("callback error does not break execute()", async () => {
		const { session } = createSession([
			{ status: 200, body: makeSessionResponse() },
			{ status: 200, body: makeLoginResponse() },
			{ status: 200, body: makeV2Response() },
		]);

		await session.connect();

		session.onResponse(() => {
			throw new Error("callback boom");
		});

		// execute should not throw despite the callback error
		const response = await session.execute("spacemolt", "get_state");
		expect(response).toBeDefined();
	});
});

describe("AccountManager with StateUpdater", () => {
	const activeSessions: Session[] = [];
	afterEach(() => {
		for (const session of activeSessions) {
			session.disconnect();
		}
		activeSessions.length = 0;
	});

	function createMockClient(responses: Parameters<typeof createMockFetch>[0]): {
		client: SpaceMoltClient;
		mockFetch: ReturnType<typeof createMockFetch>;
	} {
		const mockFetch = createMockFetch(responses);
		const client = new SpaceMoltClient({
			baseUrl: "https://test.spacemolt.com",
			fetch: mockFetch,
		});
		return { client, mockFetch };
	}

	test("login response populates state store", async () => {
		const { client } = createMockClient([
			{ status: 200, body: makeSessionResponse("sess-1") },
			{ status: 200, body: makeLoginResponse() },
		]);

		const db = createMemoryDatabase();
		const store = new StateStore(db);
		const updater = new StateUpdater(store);

		const manager = new AccountManager(client, {
			staggerDelayMs: 0,
			keepaliveIntervalMs: 60_000,
			stateUpdater: updater,
		});

		const config = {
			username: "TestPlayer",
			password: "secret123",
			player_id: "test-player-id",
		};

		const account = await manager.connectAccount(config);
		activeSessions.push(account.session);

		// State should be populated from login response
		const state = store.getState("test-player-id");
		expect(state).toBeDefined();
		expect(state?.player?.id).toBe("test-player-id");
		expect(state?.player?.username).toBe("TestPlayer");
		expect(state?.ship?.id).toBe("test-ship-id");
		expect(state?.location?.system_id).toBe("sol");

		manager.disconnectAll();
	});

	test("subsequent actions update state store", async () => {
		const updatedGameState = makeGameStateContent();
		updatedGameState.player = {
			id: "test-player-id",
			username: "TestPlayer",
			credits: 5000,
			empire: "solarian",
		};

		const { client } = createMockClient([
			// Connect
			{ status: 200, body: makeSessionResponse("sess-1") },
			{ status: 200, body: makeLoginResponse() },
			// Action response with updated state
			{
				status: 200,
				body: makeV2Response({
					structuredContent: updatedGameState as unknown as Record<string, never>,
				}),
			},
		]);

		const db = createMemoryDatabase();
		const store = new StateStore(db);
		const updater = new StateUpdater(store);

		const manager = new AccountManager(client, {
			staggerDelayMs: 0,
			keepaliveIntervalMs: 60_000,
			stateUpdater: updater,
		});

		const config = {
			username: "TestPlayer",
			password: "secret123",
			player_id: "test-player-id",
		};

		const account = await manager.connectAccount(config);
		activeSessions.push(account.session);

		// Initial state from login
		const initialState = store.getState("test-player-id");
		expect(initialState?.player?.credits).toBe(1000);

		// Execute an action that returns updated state
		await account.session.execute("spacemolt", "buy", { id: "fuel", quantity: 10 });

		// State should be updated
		const updatedState = store.getState("test-player-id");
		expect(updatedState?.player?.credits).toBe(5000);

		manager.disconnectAll();
	});

	test("state change events fire on action responses", async () => {
		const gameState = makeGameStateContent();

		const { client } = createMockClient([
			{ status: 200, body: makeSessionResponse("sess-1") },
			{ status: 200, body: makeLoginResponse() },
			{
				status: 200,
				body: makeV2Response({
					structuredContent: gameState as unknown as Record<string, never>,
				}),
			},
		]);

		const db = createMemoryDatabase();
		const store = new StateStore(db);
		const updater = new StateUpdater(store);

		const events: StateChangeEvent[] = [];
		updater.onStateChange((event) => events.push(event));

		const manager = new AccountManager(client, {
			staggerDelayMs: 0,
			keepaliveIntervalMs: 60_000,
			stateUpdater: updater,
		});

		const config = {
			username: "TestPlayer",
			password: "secret123",
			player_id: "test-player-id",
		};

		const account = await manager.connectAccount(config);
		activeSessions.push(account.session);

		// No events yet — login goes through processLoginResponse which doesn't emit
		expect(events).toHaveLength(0);

		// Action response should trigger state change event
		await account.session.execute("spacemolt", "get_state");

		expect(events.length).toBeGreaterThan(0);
		expect(events[0]?.accountId).toBe("test-player-id");

		manager.disconnectAll();
	});

	test("multiple accounts get independent state", async () => {
		const { client } = createMockClient([
			// Account 1
			{ status: 200, body: makeSessionResponse("sess-1") },
			{
				status: 200,
				body: makeV2Response({
					structuredContent: {
						message: "Welcome!",
						player: { id: "player-1", username: "Player1", credits: 100, empire: "solarian" },
						ship: { id: "ship-1", class_id: "scout", name: "Scout 1" },
						system: {
							id: "sol",
							name: "Sol",
							empire: "solarian",
							police_level: 5,
							connections: [],
							pois: [],
						},
						poi: { id: "sol-station", system_id: "sol", name: "Sol Station", type: "station" },
						captains_log: [],
						pending_trades: [],
					} as unknown as Record<string, never>,
					session: {
						id: "sess-1",
						player_id: "player-1",
						created_at: "2026-01-01T00:00:00Z",
						expires_at: "2026-01-01T00:30:00Z",
					},
				}),
			},
			// Account 2
			{ status: 200, body: makeSessionResponse("sess-2") },
			{
				status: 200,
				body: makeV2Response({
					structuredContent: {
						message: "Welcome!",
						player: { id: "player-2", username: "Player2", credits: 500, empire: "colonial" },
						ship: { id: "ship-2", class_id: "freighter", name: "Freighter 1" },
						system: {
							id: "alpha",
							name: "Alpha Centauri",
							empire: "colonial",
							police_level: 3,
							connections: [],
							pois: [],
						},
						poi: {
							id: "alpha-station",
							system_id: "alpha",
							name: "Alpha Station",
							type: "station",
						},
						captains_log: [],
						pending_trades: [],
					} as unknown as Record<string, never>,
					session: {
						id: "sess-2",
						player_id: "player-2",
						created_at: "2026-01-01T00:00:00Z",
						expires_at: "2026-01-01T00:30:00Z",
					},
				}),
			},
		]);

		const db = createMemoryDatabase();
		const store = new StateStore(db);
		const updater = new StateUpdater(store);

		const manager = new AccountManager(client, {
			staggerDelayMs: 0,
			keepaliveIntervalMs: 60_000,
			stateUpdater: updater,
		});

		const configs = [
			{ username: "Player1", password: "pass1", player_id: "player-1" },
			{ username: "Player2", password: "pass2", player_id: "player-2" },
		];

		const connected = await manager.connectAll(configs);
		for (const account of connected) {
			activeSessions.push(account.session);
		}

		const state1 = store.getState("player-1");
		const state2 = store.getState("player-2");

		expect(state1?.player?.username).toBe("Player1");
		expect(state1?.player?.credits).toBe(100);
		expect(state1?.location?.system_id).toBe("sol");

		expect(state2?.player?.username).toBe("Player2");
		expect(state2?.player?.credits).toBe(500);
		expect(state2?.location?.system_id).toBe("alpha");

		manager.disconnectAll();
	});

	test("works without stateUpdater (backwards compatible)", async () => {
		const { client } = createMockClient([
			{ status: 200, body: makeSessionResponse("sess-1") },
			{ status: 200, body: makeLoginResponse() },
		]);

		const manager = new AccountManager(client, {
			staggerDelayMs: 0,
			keepaliveIntervalMs: 60_000,
			// No stateUpdater
		});

		const config = {
			username: "TestPlayer",
			password: "secret123",
			player_id: "test-player-id",
		};

		const account = await manager.connectAccount(config);
		activeSessions.push(account.session);

		expect(account.session.state).toBe("active");

		manager.disconnectAll();
	});
});
