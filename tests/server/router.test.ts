import { describe, expect, test } from "bun:test";
import { Router, errorResponse, jsonResponse } from "../../src/server/router.js";

describe("jsonResponse", () => {
	test("returns JSON with default 200 status", () => {
		const res = jsonResponse({ hello: "world" });
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/json");
	});

	test("accepts custom status", () => {
		const res = jsonResponse({ created: true }, 201);
		expect(res.status).toBe(201);
	});
});

describe("errorResponse", () => {
	test("returns error JSON", async () => {
		const res = errorResponse("bad request", 400);
		expect(res.status).toBe(400);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["error"]).toBe("bad request");
	});
});

describe("Router", () => {
	test("matches exact path", async () => {
		const router = new Router<string>();
		router.get("/health", () => jsonResponse({ ok: true }));

		const res = await router.handle(new Request("http://localhost/health"), "ctx");
		expect(res.status).toBe(200);
	});

	test("returns 404 for unmatched path", async () => {
		const router = new Router<string>();
		router.get("/health", () => jsonResponse({ ok: true }));

		const res = await router.handle(new Request("http://localhost/missing"), "ctx");
		expect(res.status).toBe(404);
	});

	test("matches method correctly", async () => {
		const router = new Router<string>();
		router.get("/test", () => jsonResponse({ method: "GET" }));
		router.post("/test", () => jsonResponse({ method: "POST" }));

		const getRes = await router.handle(new Request("http://localhost/test"), "ctx");
		const getBody = (await getRes.json()) as Record<string, unknown>;
		expect(getBody["method"]).toBe("GET");

		const postRes = await router.handle(
			new Request("http://localhost/test", { method: "POST" }),
			"ctx",
		);
		const postBody = (await postRes.json()) as Record<string, unknown>;
		expect(postBody["method"]).toBe("POST");
	});

	test("extracts :param segments", async () => {
		const router = new Router<string>();
		router.get("/accounts/:playerId", (_req, params) => jsonResponse({ id: params["playerId"] }));

		const res = await router.handle(new Request("http://localhost/accounts/abc-123"), "ctx");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["id"]).toBe("abc-123");
	});

	test("extracts multiple params", async () => {
		const router = new Router<string>();
		router.get("/accounts/:playerId/state/:section", (_req, params) =>
			jsonResponse({ id: params["playerId"], section: params["section"] }),
		);

		const res = await router.handle(new Request("http://localhost/accounts/p1/state/ship"), "ctx");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["id"]).toBe("p1");
		expect(body["section"]).toBe("ship");
	});

	test("passes context to handler", async () => {
		const router = new Router<{ value: number }>();
		router.get("/test", (_req, _params, ctx) => jsonResponse({ value: ctx.value }));

		const res = await router.handle(new Request("http://localhost/test"), { value: 42 });
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["value"]).toBe(42);
	});

	test("catches handler errors and returns 500", async () => {
		const router = new Router<string>();
		router.get("/broken", () => {
			throw new Error("boom");
		});

		const res = await router.handle(new Request("http://localhost/broken"), "ctx");
		expect(res.status).toBe(500);
	});

	test("decodes URI-encoded params", async () => {
		const router = new Router<string>();
		router.get("/accounts/:playerId", (_req, params) => jsonResponse({ id: params["playerId"] }));

		const res = await router.handle(new Request("http://localhost/accounts/hello%20world"), "ctx");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body["id"]).toBe("hello world");
	});
});
