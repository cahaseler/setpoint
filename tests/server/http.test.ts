import { describe, expect, test } from "bun:test";
import { errorResponse, jsonResponse } from "../../src/server/http.js";

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
