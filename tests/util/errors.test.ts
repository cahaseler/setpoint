import { describe, expect, test } from "bun:test";
import { ApiError, HttpError, RateLimitError, SessionExpiredError } from "../../src/util/errors.js";

describe("ApiError", () => {
	test("constructs with code, message, and status", () => {
		const err = new ApiError("invalid_params", "Missing item ID", 400);
		expect(err.name).toBe("ApiError");
		expect(err.code).toBe("invalid_params");
		expect(err.message).toBe("Missing item ID");
		expect(err.statusCode).toBe(400);
		expect(err).toBeInstanceOf(Error);
	});

	test("fromResponse creates ApiError from response error object", () => {
		const err = ApiError.fromResponse({ code: "game_error", message: "Not enough fuel" }, 400);
		expect(err.code).toBe("game_error");
		expect(err.message).toBe("Not enough fuel");
		expect(err.statusCode).toBe(400);
	});

	test("fromResponse handles missing fields", () => {
		const err = ApiError.fromResponse({}, 500);
		expect(err.code).toBe("unknown");
		expect(err.message).toBe("Unknown error");
	});
});

describe("HttpError", () => {
	test("constructs with message and status code", () => {
		const err = new HttpError("Server error", 500);
		expect(err.name).toBe("HttpError");
		expect(err.message).toBe("Server error");
		expect(err.statusCode).toBe(500);
		expect(err).toBeInstanceOf(Error);
	});
});

describe("SessionExpiredError", () => {
	test("is an ApiError with 401 status", () => {
		const err = new SessionExpiredError();
		expect(err.name).toBe("SessionExpiredError");
		expect(err.code).toBe("session_expired");
		expect(err.statusCode).toBe(401);
		expect(err).toBeInstanceOf(ApiError);
	});

	test("accepts custom message", () => {
		const err = new SessionExpiredError("Custom message");
		expect(err.message).toBe("Custom message");
	});
});

describe("RateLimitError", () => {
	test("includes retry-after seconds", () => {
		const err = new RateLimitError("Too many requests", 30);
		expect(err.name).toBe("RateLimitError");
		expect(err.code).toBe("rate_limited");
		expect(err.statusCode).toBe(429);
		expect(err.retryAfterSeconds).toBe(30);
		expect(err).toBeInstanceOf(ApiError);
	});
});
