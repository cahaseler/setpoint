import { afterEach, describe, expect, test } from "bun:test";
import { ConnectionError, DaemonClient, TimeoutError } from "../../src/cli/client.js";

describe("DaemonClient", () => {
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
		globalThis.fetch = (() => {
			return Promise.reject(new TypeError("fetch failed"));
		}) as unknown as typeof fetch;
	}

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("GET sends correct request and returns response", async () => {
		mockFetch(200, { status: "ok" });
		const client = new DaemonClient({ port: 7580 });

		const result = await client.get("/health");

		expect(result.status).toBe(200);
		expect(result.data).toEqual({ status: "ok" });
		expect(fetchCalls).toHaveLength(1);
		expect(fetchCalls[0]?.url).toBe("http://localhost:7580/health");
		expect(fetchCalls[0]?.init?.method).toBe("GET");
	});

	test("POST sends JSON body", async () => {
		mockFetch(201, { message: "created" });
		const client = new DaemonClient({ port: 9000 });

		const result = await client.post("/accounts", { username: "test" });

		expect(result.status).toBe(201);
		expect(fetchCalls[0]?.url).toBe("http://localhost:9000/accounts");
		expect(fetchCalls[0]?.init?.method).toBe("POST");
		const headers = fetchCalls[0]?.init?.headers as Record<string, string>;
		expect(headers["Content-Type"]).toBe("application/json");
		expect(fetchCalls[0]?.init?.body).toBe(JSON.stringify({ username: "test" }));
	});

	test("DELETE sends correct method", async () => {
		mockFetch(200, { message: "deleted" });
		const client = new DaemonClient({ port: 7580 });

		await client.delete("/accounts/p1");

		expect(fetchCalls[0]?.init?.method).toBe("DELETE");
		expect(fetchCalls[0]?.url).toBe("http://localhost:7580/accounts/p1");
	});

	test("POST without body omits content-type", async () => {
		mockFetch(200, {});
		const client = new DaemonClient({ port: 7580 });

		await client.post("/log-level");

		expect(fetchCalls[0]?.init?.headers).toBeUndefined();
		expect(fetchCalls[0]?.init?.body).toBeUndefined();
	});

	test("throws ConnectionError when all retry attempts fail", async () => {
		mockFetchError();
		const client = new DaemonClient({ port: 7580, retryDelayMs: 0 });

		await expect(client.get("/health")).rejects.toThrow(ConnectionError);
		try {
			await client.get("/health");
		} catch (err) {
			expect(err).toBeInstanceOf(ConnectionError);
			expect((err as ConnectionError).port).toBe(7580);
		}
	});

	test("retries 3 times on connection error before throwing", async () => {
		fetchCalls = [];
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: url.toString(), init });
			return Promise.reject(new TypeError("fetch failed"));
		}) as unknown as typeof fetch;

		const client = new DaemonClient({ port: 7580, retryDelayMs: 0 });

		await expect(client.get("/health")).rejects.toThrow(ConnectionError);
		expect(fetchCalls).toHaveLength(3);
	});

	test("succeeds on second attempt after transient connection failure", async () => {
		fetchCalls = [];
		let calls = 0;
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: url.toString(), init });
			calls++;
			if (calls === 1) {
				return Promise.reject(new TypeError("fetch failed"));
			}
			return Promise.resolve(
				new Response(JSON.stringify({ status: "ok" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as typeof fetch;

		const client = new DaemonClient({ port: 7580, retryDelayMs: 0 });
		const result = await client.get("/health");

		expect(result.status).toBe(200);
		expect(fetchCalls).toHaveLength(2); // 1 failure + 1 success
	});

	test("POST does not retry on connection error — fails after a single attempt", async () => {
		fetchCalls = [];
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: url.toString(), init });
			return Promise.reject(new TypeError("fetch failed"));
		}) as unknown as typeof fetch;

		const client = new DaemonClient({ port: 7580, retryDelayMs: 0 });

		await expect(client.post("/accounts/p1/goal", { type: "create-buy-order" })).rejects.toThrow(
			ConnectionError,
		);
		expect(fetchCalls).toHaveLength(1);
	});

	test("DELETE does not retry on connection error — fails after a single attempt", async () => {
		fetchCalls = [];
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: url.toString(), init });
			return Promise.reject(new TypeError("fetch failed"));
		}) as unknown as typeof fetch;

		const client = new DaemonClient({ port: 7580, retryDelayMs: 0 });

		await expect(client.delete("/accounts/p1/loop")).rejects.toThrow(ConnectionError);
		expect(fetchCalls).toHaveLength(1);
	});

	test("throws TimeoutError immediately on timeout without retrying", async () => {
		fetchCalls = [];
		globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: _url.toString(), init });
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted", "AbortError"));
				});
			});
		}) as unknown as typeof fetch;

		const client = new DaemonClient({ port: 7580, requestTimeoutMs: 1, retryDelayMs: 0 });

		const start = Date.now();
		await expect(client.get("/health")).rejects.toThrow(TimeoutError);
		const elapsed = Date.now() - start;

		// Should abort quickly and NOT retry — only 1 fetch call
		expect(fetchCalls).toHaveLength(1);
		expect(elapsed).toBeLessThan(2000);
	});

	test("TimeoutError includes path and timeout duration", async () => {
		fetchCalls = [];
		globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: _url.toString(), init });
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted", "AbortError"));
				});
			});
		}) as unknown as typeof fetch;

		const client = new DaemonClient({ port: 7580, requestTimeoutMs: 1, retryDelayMs: 0 });

		try {
			await client.get("/accounts/test/state");
		} catch (err) {
			expect(err).toBeInstanceOf(TimeoutError);
			const te = err as TimeoutError;
			expect(te.port).toBe(7580);
			expect(te.path).toBe("/accounts/test/state");
			expect(te.message).toContain("did not respond");
		}
	});

	test("post uses per-request requestTimeoutMs instead of constructor default", async () => {
		fetchCalls = [];
		let abortedSignal = false;
		globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: _url.toString(), init });
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener("abort", () => {
					abortedSignal = true;
					reject(new DOMException("The operation was aborted", "AbortError"));
				});
				// Never resolves — waits for abort
			});
		}) as unknown as typeof fetch;

		// Constructor default is 60s, but per-request override is 1ms
		const client = new DaemonClient({ port: 7580, requestTimeoutMs: 60_000, retryDelayMs: 0 });

		const start = Date.now();
		await expect(client.post("/goal", {}, { requestTimeoutMs: 1 })).rejects.toThrow(TimeoutError);
		const elapsed = Date.now() - start;

		expect(abortedSignal).toBe(true);
		// Should have aborted within ~1ms, not waited 60s
		expect(elapsed).toBeLessThan(2000);
	});

	test("post uses constructor timeout when no per-request override", async () => {
		fetchCalls = [];
		let abortedSignal = false;
		globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: _url.toString(), init });
			return new Promise<Response>((_, reject) => {
				init?.signal?.addEventListener("abort", () => {
					abortedSignal = true;
					reject(new DOMException("The operation was aborted", "AbortError"));
				});
			});
		}) as unknown as typeof fetch;

		const client = new DaemonClient({ port: 7580, requestTimeoutMs: 1, retryDelayMs: 0 });
		await expect(client.post("/goal", {})).rejects.toThrow(TimeoutError);
		expect(abortedSignal).toBe(true);
	});

	test("handles non-JSON response gracefully", async () => {
		fetchCalls = [];
		globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
			fetchCalls.push({ url: url.toString(), init });
			return Promise.resolve(
				new Response("not json", {
					status: 500,
					headers: { "Content-Type": "text/plain" },
				}),
			);
		}) as typeof fetch;

		const client = new DaemonClient({ port: 7580 });
		const result = await client.get("/health");

		expect(result.status).toBe(500);
		expect(result.data).toEqual({ error: "Invalid response from daemon" });
	});

	test("default timeout is 30 seconds", async () => {
		const client = new DaemonClient({ port: 7580 });
		// Access private field via bracket notation for testing
		expect((client as unknown as Record<string, unknown>)["requestTimeoutMs"]).toBe(30_000);
	});
});
