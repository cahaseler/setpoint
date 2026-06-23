import { describe, expect, test } from "bun:test";
import { resolveBindHost } from "../../src/server/index.js";

describe("resolveBindHost", () => {
	test("defaults to loopback when SM_HOST is unset", () => {
		expect(resolveBindHost({})).toBe("127.0.0.1");
	});

	test("honors SM_HOST when set", () => {
		expect(resolveBindHost({ SM_HOST: "0.0.0.0" })).toBe("0.0.0.0");
	});
});
