import { describe, expect, test } from "bun:test";
import { isUnboundedRequest, resolveBindHost } from "../../src/server/index.js";

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

	test("other GET requests are not unbounded", () => {
		expect(isUnboundedRequest(new Request("http://x/accounts/p1/raw", { method: "GET" }))).toBe(
			false,
		);
	});

	test("POST /accounts (add) is not unbounded — connects in the background, returns 202 immediately", () => {
		expect(isUnboundedRequest(new Request("http://x/accounts", { method: "POST" }))).toBe(false);
	});
});
