import { describe, expect, test } from "bun:test";
import { SpaceMoltClient } from "../../src/api/client.js";
import { BandwidthTracker } from "../../src/util/bandwidth-tracker.js";
import { ApiError, HttpError, RateLimitError, SessionExpiredError } from "../../src/util/errors.js";
import {
	createMockFetch,
	makeErrorResponse,
	makeSessionResponse,
	makeV2Response,
} from "../fixtures/api-responses.js";

describe("SpaceMoltClient", () => {
	function createClient(responses: Parameters<typeof createMockFetch>[0]): {
		client: SpaceMoltClient;
		mockFetch: ReturnType<typeof createMockFetch>;
	} {
		const mockFetch = createMockFetch(responses);
		const client = new SpaceMoltClient({
			baseUrl: "https://test.spacemolt.com",
			fetch: mockFetch,
			retryDelayMs: 0,
		});
		return { client, mockFetch };
	}

	function createClientWithTracker(responses: Parameters<typeof createMockFetch>[0]): {
		client: SpaceMoltClient;
		tracker: BandwidthTracker;
	} {
		const mockFetch = createMockFetch(responses);
		const tracker = new BandwidthTracker();
		const client = new SpaceMoltClient({
			baseUrl: "https://test.spacemolt.com",
			fetch: mockFetch,
			retryDelayMs: 0,
			bandwidthTracker: tracker,
		});
		return { client, tracker };
	}

	describe("createSession", () => {
		test("creates a session and returns session info", async () => {
			const { client, mockFetch } = createClient([
				{ status: 200, body: makeSessionResponse("session-123") },
			]);

			const result = await client.createSession();

			expect(result.session?.id).toBe("session-123");
			expect(mockFetch.calls).toHaveLength(1);
			expect(mockFetch.calls[0]?.url).toBe("https://test.spacemolt.com/api/v2/session");
		});

		test("throws RateLimitError on 429", async () => {
			const { client } = createClient([
				{
					status: 429,
					body: { message: "Too many session creation requests" },
					headers: { "Retry-After": "30" },
				},
			]);

			const err = await client.createSession().catch((e: unknown) => e);
			expect(err).toBeInstanceOf(RateLimitError);
			expect((err as RateLimitError).retryAfterSeconds).toBe(30);
		});
	});

	describe("gameAction", () => {
		test("sends POST with session header and JSON body", async () => {
			const responseBody = makeV2Response({
				structuredContent: { action: "arrived", poi: "Alpha Station" } as unknown as Record<
					string,
					never
				>,
			});
			const { client, mockFetch } = createClient([{ status: 200, body: responseBody }]);

			const result = await client.gameAction(
				"spacemolt",
				"travel",
				{ id: "alpha-centauri" },
				"session-123",
			);

			expect(result.structuredContent).toEqual({ action: "arrived", poi: "Alpha Station" });

			const call = mockFetch.calls[0];
			expect(call?.url).toBe("https://test.spacemolt.com/api/v2/spacemolt/travel");
			expect(call?.init?.method).toBe("POST");

			const headers = call?.init?.headers as Record<string, string>;
			expect(headers["X-Session-Id"]).toBe("session-123");
			expect(headers["Content-Type"]).toBe("application/json");

			const body = JSON.parse(call?.init?.body as string) as Record<string, unknown>;
			expect(body["id"]).toBe("alpha-centauri");
		});

		test("requests zstd compression with gzip fallback", async () => {
			const { client, mockFetch } = createClient([{ status: 200, body: makeV2Response() }]);

			await client.gameAction("spacemolt", "get_state", {}, "session-123");

			const headers = mockFetch.calls[0]?.init?.headers as Record<string, string>;
			expect(headers["Accept-Encoding"]).toBe("zstd, gzip");
		});

		test("parses notifications from response", async () => {
			const responseBody = makeV2Response({
				notifications: [
					{
						id: "notif-1",
						type: "system",
						timestamp: "2026-02-19T00:00:00Z",
						data: {} as Record<string, never>,
					},
				],
			});
			const { client } = createClient([{ status: 200, body: responseBody }]);

			const result = await client.gameAction("spacemolt", "get_state", {}, "session-123");
			expect(result.notifications).toHaveLength(1);
			expect(result.notifications[0]?.type).toBe("system");
		});
	});

	describe("authAction", () => {
		test("sends auth params to auth endpoint", async () => {
			const { client, mockFetch } = createClient([{ status: 200, body: makeV2Response() }]);

			await client.authAction(
				"login",
				{ username: "TestPlayer", password: "secret" },
				"session-123",
			);

			const call = mockFetch.calls[0];
			expect(call?.url).toBe("https://test.spacemolt.com/api/v2/spacemolt_auth/login");

			const body = JSON.parse(call?.init?.body as string) as Record<string, unknown>;
			expect(body["username"]).toBe("TestPlayer");
			expect(body["password"]).toBe("secret");
		});
	});

	describe("error handling", () => {
		test("throws SessionExpiredError on 401", async () => {
			const { client } = createClient([{ status: 401 }]);

			const err = await client
				.gameAction("spacemolt", "get_state", {}, "expired-session")
				.catch((e: unknown) => e);

			expect(err).toBeInstanceOf(SessionExpiredError);
			expect((err as SessionExpiredError).statusCode).toBe(401);
		});

		test("throws RateLimitError on 429 with Retry-After header", async () => {
			const { client } = createClient([
				{
					status: 429,
					body: { message: "Slow down" },
					headers: { "Retry-After": "15" },
				},
			]);

			const err = await client
				.gameAction("spacemolt", "travel", {}, "session-123")
				.catch((e: unknown) => e);

			expect(err).toBeInstanceOf(RateLimitError);
			expect((err as RateLimitError).retryAfterSeconds).toBe(15);
			expect((err as RateLimitError).message).toBe("Slow down");
		});

		test("defaults to 60s retry when Retry-After header missing", async () => {
			const { client } = createClient([{ status: 429 }]);

			const err = await client
				.gameAction("spacemolt", "travel", {}, "session-123")
				.catch((e: unknown) => e);

			expect(err).toBeInstanceOf(RateLimitError);
			expect((err as RateLimitError).retryAfterSeconds).toBe(60);
		});

		test("throws ApiError when response body contains error", async () => {
			const { client } = createClient([
				{ status: 400, body: makeErrorResponse("invalid_params", "Missing item ID") },
			]);

			const err = await client
				.gameAction("spacemolt", "buy", {}, "session-123")
				.catch((e: unknown) => e);

			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).code).toBe("invalid_params");
			expect((err as ApiError).message).toBe("Missing item ID");
			expect((err as ApiError).statusCode).toBe(400);
		});

		test("throws ApiError when 200 response contains error field", async () => {
			const { client } = createClient([
				{ status: 200, body: makeErrorResponse("game_error", "Not enough fuel") },
			]);

			const err = await client
				.gameAction("spacemolt", "travel", {}, "session-123")
				.catch((e: unknown) => e);

			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).code).toBe("game_error");
		});

		test("treats session/auth error codes as recoverable session errors", async () => {
			for (const code of ["not_authenticated", "session_invalid", "session_required"]) {
				const { client } = createClient([
					{ status: 200, body: makeErrorResponse(code, "You must be logged in") },
				]);

				const err = await client
					.gameAction("spacemolt", "mine", {}, "session-123")
					.catch((e: unknown) => e);

				expect(err).toBeInstanceOf(SessionExpiredError);
			}
		});

		test("treats session/auth error codes as recoverable even on a 4xx status", async () => {
			const { client } = createClient([
				{ status: 403, body: makeErrorResponse("not_authenticated", "You must be logged in") },
			]);

			const err = await client
				.gameAction("spacemolt", "mine", {}, "session-123")
				.catch((e: unknown) => e);

			expect(err).toBeInstanceOf(SessionExpiredError);
		});

		test("throws HttpError on non-JSON error response", async () => {
			const resp = { status: 500, headers: { "Content-Type": "text/plain" } };
			const { client } = createClient([resp, resp, resp, resp, resp]);

			const err = await client
				.gameAction("spacemolt", "get_state", {}, "session-123")
				.catch((e: unknown) => e);

			expect(err).toBeInstanceOf(HttpError);
			expect((err as HttpError).statusCode).toBe(500);
		});

		test("retries on 5xx and succeeds on subsequent attempt", async () => {
			const { client, mockFetch } = createClient([
				{ status: 502, headers: { "Content-Type": "text/html" } },
				{ status: 200, body: makeV2Response({ result: "ok" }) },
			]);

			const result = await client.gameAction("spacemolt", "get_state", {}, "session-123");
			expect(result.result).toBe("ok");
			expect(mockFetch.calls).toHaveLength(2);
		});

		test("throws HttpError on network failure", async () => {
			const mockFetch = (() => {
				throw new Error("Connection refused");
			}) as unknown as typeof globalThis.fetch;

			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com",
				fetch: mockFetch,
			});

			const err = await client.createSession().catch((e: unknown) => e);

			expect(err).toBeInstanceOf(HttpError);
			expect((err as HttpError).message).toContain("Connection refused");
			expect((err as HttpError).statusCode).toBe(0);
		});
	});

	describe("URL construction", () => {
		test("strips trailing slashes from base URL", async () => {
			const mockFetch = createMockFetch([{ status: 200, body: makeSessionResponse() }]);
			const client = new SpaceMoltClient({
				baseUrl: "https://test.spacemolt.com///",
				fetch: mockFetch,
			});

			await client.createSession();

			expect(mockFetch.calls[0]?.url).toBe("https://test.spacemolt.com/api/v2/session");
		});
	});

	describe("bandwidth tracking", () => {
		test("records compressed bytes from Content-Length header", async () => {
			const { client, tracker } = createClientWithTracker([
				{
					status: 200,
					body: makeV2Response({}),
					headers: { "Content-Length": "512" },
				},
			]);

			await client.gameAction("spacemolt", "get_state", {}, "session-123", "Player1");

			const stats = tracker.getStats();
			expect(stats.requests).toBe(1);
			expect(stats.bytes).toBe(512);
			expect(stats.byAccount.get("Player1")).toBe(512);
			expect(stats.byEndpoint.get("/api/v2/spacemolt/get_state")).toBe(512);
		});

		test("falls back to body byte length when Content-Length absent", async () => {
			const body = makeV2Response({});
			const { client, tracker } = createClientWithTracker([{ status: 200, body }]);

			await client.gameAction("spacemolt", "get_state", {}, "session-123", "Player1");

			const stats = tracker.getStats();
			expect(stats.requests).toBe(1);
			expect(stats.bytes).toBeGreaterThan(0);
		});

		test("records with correct accountId and endpoint for authAction", async () => {
			const { client, tracker } = createClientWithTracker([
				{
					status: 200,
					body: makeV2Response({}),
					headers: { "Content-Length": "200" },
				},
			]);

			await client.authAction("login", { username: "Player1" }, "session-123", "Player1");

			const stats = tracker.getStats();
			expect(stats.byAccount.get("Player1")).toBe(200);
			expect(stats.byEndpoint.get("/api/v2/spacemolt_auth/login")).toBe(200);
		});

		test("does not record when no accountId provided", async () => {
			const { client, tracker } = createClientWithTracker([
				{ status: 200, body: makeV2Response({}) },
			]);

			await client.gameAction("spacemolt", "get_state", {}, "session-123");

			const stats = tracker.getStats();
			expect(stats.requests).toBe(0);
		});

		test("accumulates bytes across multiple requests for same account", async () => {
			const { client, tracker } = createClientWithTracker([
				{ status: 200, body: makeV2Response({}), headers: { "Content-Length": "100" } },
				{ status: 200, body: makeV2Response({}), headers: { "Content-Length": "200" } },
			]);

			await client.gameAction("spacemolt", "get_state", {}, "session-123", "Player1");
			await client.gameAction("spacemolt", "travel", {}, "session-123", "Player1");

			const stats = tracker.getStats();
			expect(stats.bytes).toBe(300);
			expect(stats.byAccount.get("Player1")).toBe(300);
		});
	});

	describe("forward", () => {
		test("sends branded headers and forwards method, path, body, session, content-type", async () => {
			const { client, mockFetch } = createClient([
				{ status: 200, body: { structuredContent: { ok: true } } },
			]);

			const result = await client.forward(
				"POST",
				"/api/v2/spacemolt/travel?foo=bar",
				JSON.stringify({ id: "sol" }),
				"sess-abc",
				"application/json",
			);

			expect(result.status).toBe(200);
			expect(result.contentType).toBe("application/json");
			expect(JSON.parse(result.body)).toEqual({ structuredContent: { ok: true } });

			const call = mockFetch.calls[0];
			expect(call?.url).toBe("https://test.spacemolt.com/api/v2/spacemolt/travel?foo=bar");
			expect(call?.init?.method).toBe("POST");
			expect(call?.init?.body).toBe(JSON.stringify({ id: "sol" }));

			const headers = call?.init?.headers as Record<string, string>;
			expect(headers["User-Agent"]).toStartWith("setpoint/");
			expect(headers["Accept-Encoding"]).toBe("zstd, gzip");
			expect(headers["X-Session-Id"]).toBe("sess-abc");
			expect(headers["Content-Type"]).toBe("application/json");
		});

		test("relays a non-2xx game response verbatim instead of throwing", async () => {
			const { client } = createClient([{ status: 400, body: { error: { code: "bad_request" } } }]);

			const result = await client.forward(
				"POST",
				"/api/v2/spacemolt/buy",
				"{}",
				"sess-abc",
				"application/json",
			);

			expect(result.status).toBe(400);
			expect(JSON.parse(result.body)).toEqual({ error: { code: "bad_request" } });
		});

		test("omits the request body for GET", async () => {
			const { client, mockFetch } = createClient([{ status: 200, body: {} }]);

			await client.forward("GET", "/api/v2/notifications", undefined, "sess-abc", undefined);

			expect(mockFetch.calls[0]?.init?.method).toBe("GET");
			expect(mockFetch.calls[0]?.init?.body).toBeUndefined();
		});

		test("records bandwidth under the raw-proxy account, stripping the query string", async () => {
			const { client, tracker } = createClientWithTracker([
				{ status: 200, body: {}, headers: { "Content-Length": "42" } },
			]);

			await client.forward(
				"POST",
				"/api/v2/spacemolt/get_state?x=1",
				"{}",
				"sess-abc",
				"application/json",
			);

			const stats = tracker.getStats();
			expect(stats.byAccount.get("raw-proxy")).toBe(42);
			expect(stats.byEndpoint.get("/api/v2/spacemolt/get_state")).toBe(42);
		});
	});
});
