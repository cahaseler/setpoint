import { describe, expect, test } from "bun:test";
import {
	isUnboundedRequest,
	resolveBindHost,
	stopGracefully,
	stopServerWithGracePeriod,
} from "../../src/server/index.js";

describe("resolveBindHost", () => {
	test("defaults to loopback when SM_HOST is unset", () => {
		expect(resolveBindHost({})).toBe("127.0.0.1");
	});

	test("honors SM_HOST when set", () => {
		expect(resolveBindHost({ SM_HOST: "0.0.0.0" })).toBe("0.0.0.0");
	});
});

describe("isUnboundedRequest", () => {
	test("POST .../goal is unbounded", () => {
		expect(isUnboundedRequest(new Request("http://x/accounts/p1/goal", { method: "POST" }))).toBe(
			true,
		);
	});

	test("POST .../raw is unbounded (e.g. a multi-tick craft batch)", () => {
		expect(isUnboundedRequest(new Request("http://x/accounts/p1/raw", { method: "POST" }))).toBe(
			true,
		);
	});

	test("POST /accounts/register is unbounded", () => {
		expect(isUnboundedRequest(new Request("http://x/accounts/register", { method: "POST" }))).toBe(
			true,
		);
	});

	test("DELETE /accounts/:playerId (remove) is unbounded", () => {
		expect(isUnboundedRequest(new Request("http://x/accounts/p1", { method: "DELETE" }))).toBe(
			true,
		);
	});

	test("DELETE .../abort is unbounded", () => {
		expect(
			isUnboundedRequest(new Request("http://x/accounts/p1/abort", { method: "DELETE" })),
		).toBe(true);
	});

	test("POST .../goal/async is NOT unbounded (returns immediately, 202)", () => {
		expect(
			isUnboundedRequest(new Request("http://x/accounts/p1/goal/async", { method: "POST" })),
		).toBe(false);
	});

	test("GET .../crafting/events is unbounded (long-lived SSE stream)", () => {
		expect(
			isUnboundedRequest(new Request("http://x/accounts/p1/crafting/events", { method: "GET" })),
		).toBe(true);
	});

	test("GET .../combat/events is unbounded (long-lived SSE stream)", () => {
		expect(
			isUnboundedRequest(new Request("http://x/accounts/p1/combat/events", { method: "GET" })),
		).toBe(true);
	});

	test("other GET requests are not unbounded", () => {
		expect(isUnboundedRequest(new Request("http://x/accounts/p1/raw", { method: "GET" }))).toBe(
			false,
		);
	});

	test("POST /accounts (add) is not unbounded — connects in the background, returns 202 immediately", () => {
		expect(isUnboundedRequest(new Request("http://x/accounts", { method: "POST" }))).toBe(false);
	});
});

describe("stopServerWithGracePeriod", () => {
	test("resolves promptly when there are no in-flight connections", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const start = performance.now();
		await stopServerWithGracePeriod(server, 5_000);
		expect(performance.now() - start).toBeLessThan(1_000);
	});

	test("stops waiting once the grace period elapses with a connection still open", async () => {
		// Simulates a long-lived SSE stream (GET .../crafting/events) that never
		// closes on its own — server.stop()'s default graceful drain would
		// otherwise hang forever waiting for it.
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
						},
					}),
				),
		});
		const base = `http://localhost:${server.port}`;
		const res = await fetch(base);
		void res.body?.getReader().read(); // keep the connection open without ever finishing it

		const start = performance.now();
		await stopServerWithGracePeriod(server, 200);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(190);
		expect(elapsed).toBeLessThan(2_000);
	});
});

describe("stopGracefully", () => {
	test("does not hang forever if loopManager.stopAll() never resolves (e.g. a loop mid-transit)", async () => {
		// Regression: abortLoop() only flips the abort signal — a loop mid-mutation
		// (an awaited travel/jump doesn't resolve until arrival) won't actually
		// return until that mutation settles, which can take minutes. Both phases
		// must be independently bounded, or the HTTP grace period never even runs.
		const hangingLoopManager = { stopAll: () => new Promise<void>(() => {}) };
		const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });

		const start = performance.now();
		await stopGracefully(hangingLoopManager, server, 200);
		const elapsed = performance.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(190);
		expect(elapsed).toBeLessThan(2_000); // well under 2x the grace period
	});

	test("resolves promptly when loops and connections both settle quickly", async () => {
		const loopManager = { stopAll: () => Promise.resolve() };
		const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });

		const start = performance.now();
		await stopGracefully(loopManager, server, 5_000);
		expect(performance.now() - start).toBeLessThan(1_000);
	});
});
