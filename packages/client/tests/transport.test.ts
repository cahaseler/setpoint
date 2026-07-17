import { afterEach, describe, expect, test } from "bun:test";
import type { HealthStatus } from "../src/client.js";
import { SetpointClient } from "../src/client.js";
import {
	ConnectionError,
	DeprecatedGoalError,
	SetpointHttpError,
	TimeoutError,
} from "../src/errors.js";

describe("SetpointClient", () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;

	function mockFetch(status: number, body: unknown): void {
		fetchCalls = [];
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: url.toString(), init });
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					status,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as typeof fetch;
	}

	function mockFetchError(): void {
		fetchCalls = [];
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: url.toString(), init });
			return Promise.reject(new TypeError("fetch failed"));
		}) as unknown as typeof fetch;
	}

	function mockFetchAbort(): void {
		fetchCalls = [];
		globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: _url.toString(), init });
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted", "AbortError"));
				});
			});
		}) as unknown as typeof fetch;
	}

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("2xx returns parsed JSON", async () => {
		mockFetch(200, { status: "ok" });
		const client = new SetpointClient();

		const result = await client.request("GET", "/health");

		expect(result).toEqual({ status: "ok" });
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.init?.method).toBe("GET");
	});

	test("sends JSON body with Content-Type when body is present", async () => {
		mockFetch(201, { message: "created" });
		const client = new SetpointClient();

		await client.request("POST", "/accounts", { body: { username: "test" } });

		const headers = fetchCalls[0]?.init?.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/json");
		expect(fetchCalls[0]?.init?.body).toBe(JSON.stringify({ username: "test" }));
	});

	test("omits Content-Type when no body is given", async () => {
		mockFetch(200, {});
		const client = new SetpointClient();

		await client.request("GET", "/health");

		expect(fetchCalls[0]?.init?.headers).toBeUndefined();
		expect(fetchCalls[0]?.init?.body).toBeUndefined();
	});

	test("404 throws SetpointHttpError with status and body.error", async () => {
		mockFetch(404, { error: "not found" });
		const client = new SetpointClient();

		try {
			await client.request("GET", "/accounts/missing");
			throw new Error("expected request() to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(SetpointHttpError);
			const httpErr = err as SetpointHttpError;
			expect(httpErr.status).toBe(404);
			expect(httpErr.body.error).toBe("not found");
		}
		// non-2xx errors are not connection failures — no retrying.
		expect(fetchCalls).toHaveLength(1);
	});

	test("410 throws DeprecatedGoalError", async () => {
		mockFetch(410, { error: "deprecated" });
		const client = new SetpointClient();

		try {
			await client.request("POST", "/accounts/p1/loop/crafting");
			throw new Error("expected request() to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(DeprecatedGoalError);
			expect(err).toBeInstanceOf(SetpointHttpError);
			expect((err as DeprecatedGoalError).status).toBe(410);
		}
	});

	test("connection failure retries 3 times then throws ConnectionError", async () => {
		mockFetchError();
		const client = new SetpointClient({ retryDelayMs: 0 });

		await expect(client.request("GET", "/health")).rejects.toThrow(ConnectionError);
		expect(fetchCalls).toHaveLength(3);
	});

	test("POST connection failure does NOT retry — fails after a single attempt", async () => {
		mockFetchError();
		const client = new SetpointClient({ retryDelayMs: 0 });

		await expect(
			client.request("POST", "/accounts/p1/goal", { body: { type: "create-buy-order" } }),
		).rejects.toThrow(ConnectionError);
		expect(fetchCalls).toHaveLength(1);
	});

	test("DELETE connection failure does NOT retry — fails after a single attempt", async () => {
		mockFetchError();
		const client = new SetpointClient({ retryDelayMs: 0 });

		await expect(client.request("DELETE", "/accounts/p1/loop")).rejects.toThrow(ConnectionError);
		expect(fetchCalls).toHaveLength(1);
	});

	test("abort/timeout throws TimeoutError without retrying", async () => {
		mockFetchAbort();
		const client = new SetpointClient({ retryDelayMs: 0 });

		const start = Date.now();
		await expect(client.request("GET", "/health", { timeoutMs: 1 })).rejects.toThrow(TimeoutError);
		const elapsed = Date.now() - start;

		expect(fetchCalls).toHaveLength(1);
		expect(elapsed).toBeLessThan(2000);
	});

	test("configured baseUrl is honored", async () => {
		mockFetch(200, {});
		const client = new SetpointClient({ baseUrl: "http://example.test:9000" });

		await client.request("GET", "/health");

		expect(fetchCalls[0]?.url).toBe("http://example.test:9000/health");
	});

	test("default baseUrl points at localhost:7580", async () => {
		mockFetch(200, {});
		const client = new SetpointClient();

		await client.request("GET", "/health");

		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/health");
	});

	test("health() GETs /health and returns the health status", async () => {
		const status: HealthStatus = {
			status: "ok",
			uptime: 1234,
			startedAt: new Date().toISOString(),
			accounts: 2,
		};
		mockFetch(200, status);
		const client = new SetpointClient();

		const result = await client.health();

		expect(result).toEqual(status);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/health");
		expect(fetchCalls[0]?.init?.method).toBe("GET");
	});

	test("dashboard() GETs /dashboard/data and returns the dashboard data", async () => {
		const dashboard = { startedAt: new Date().toISOString(), uptimeMs: 1000, accounts: [] };
		mockFetch(200, dashboard);
		const client = new SetpointClient();

		const result = await client.dashboard();

		expect(result).toEqual(dashboard);
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/dashboard/data");
		expect(fetchCalls[0]?.init?.method).toBe("GET");
	});

	test("logLevel() with no args GETs /log-level", async () => {
		mockFetch(200, { level: "info" });
		const client = new SetpointClient();

		const result = await client.logLevel();

		expect(result).toEqual({ level: "info" });
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/log-level");
		expect(fetchCalls[0]?.init?.method).toBe("GET");
		expect(fetchCalls[0]?.init?.body).toBeUndefined();
	});

	test("logLevel(level) POSTs /log-level with {level}", async () => {
		mockFetch(200, { level: "debug", previous: "info" });
		const client = new SetpointClient();

		const result = await client.logLevel("debug");

		expect(result).toEqual({ level: "debug", previous: "info" });
		expect(fetchCalls[0]?.url).toBe("http://127.0.0.1:7580/log-level");
		expect(fetchCalls[0]?.init?.method).toBe("POST");
		expect(fetchCalls[0]?.init?.body).toBe(JSON.stringify({ level: "debug" }));
	});
});
