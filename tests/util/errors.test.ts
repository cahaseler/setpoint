import { describe, expect, test } from "bun:test";
import { ApiError, HttpError } from "../../src/util/errors.js";

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
