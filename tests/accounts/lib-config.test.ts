import { describe, expect, test } from "bun:test";
import type { ClerkPlayer } from "@spacemolt/lib";
import { ConfigError } from "../../src/accounts/config.js";
import { buildOwnedFilter, parseLibConfig } from "../../src/accounts/lib-config.js";

describe("parseLibConfig", () => {
	test("reads clerkApiKey from env", () => {
		const cfg = parseLibConfig({ SPACEMOLT_CLERK_API_KEY: "key_123" }, {});
		expect(cfg.clerkApiKey).toBe("key_123");
		expect(cfg.filter).toBeUndefined();
	});

	test("file clerkApiKey is used when env is absent", () => {
		const cfg = parseLibConfig({}, { clerkApiKey: "key_file" });
		expect(cfg.clerkApiKey).toBe("key_file");
	});

	test("env overrides file", () => {
		const cfg = parseLibConfig({ SPACEMOLT_CLERK_API_KEY: "key_env" }, { clerkApiKey: "key_file" });
		expect(cfg.clerkApiKey).toBe("key_env");
	});

	test("parses filter spec from file", () => {
		const cfg = parseLibConfig(
			{ SPACEMOLT_CLERK_API_KEY: "k" },
			{ accountsFilter: { usernames: ["Alpha"], empires: ["solarian"], includeHidden: true } },
		);
		expect(cfg.filter).toEqual({
			usernames: ["Alpha"],
			empires: ["solarian"],
			includeHidden: true,
		});
	});

	test("throws when clerkApiKey missing", () => {
		expect(() => parseLibConfig({}, {})).toThrow(ConfigError);
	});

	test("throws when clerkApiKey empty", () => {
		expect(() => parseLibConfig({ SPACEMOLT_CLERK_API_KEY: "" }, {})).toThrow(ConfigError);
	});
});

const p = (over: Partial<ClerkPlayer>): ClerkPlayer => ({
	id: "id",
	username: "Name",
	empire: "solarian",
	hidden: false,
	...over,
});

describe("buildOwnedFilter", () => {
	test("no filter → connect all non-hidden", () => {
		const f = buildOwnedFilter(undefined);
		expect(f(p({}))).toBe(true);
		expect(f(p({ hidden: true }))).toBe(false);
	});

	test("username allowlist is case-insensitive", () => {
		const f = buildOwnedFilter({ usernames: ["alpha"] });
		expect(f(p({ username: "Alpha" }))).toBe(true);
		expect(f(p({ username: "Beta" }))).toBe(false);
	});

	test("empire allowlist is case-insensitive", () => {
		const f = buildOwnedFilter({ empires: ["Solarian"] });
		expect(f(p({ empire: "solarian" }))).toBe(true);
		expect(f(p({ empire: "voidborn" }))).toBe(false);
	});

	test("includeHidden true keeps hidden players", () => {
		const f = buildOwnedFilter({ includeHidden: true });
		expect(f(p({ hidden: true }))).toBe(true);
	});

	test("clauses AND together", () => {
		const f = buildOwnedFilter({ usernames: ["alpha"], empires: ["solarian"] });
		expect(f(p({ username: "Alpha", empire: "solarian" }))).toBe(true);
		expect(f(p({ username: "Alpha", empire: "voidborn" }))).toBe(false);
	});
});
