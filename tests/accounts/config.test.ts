import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	ConfigError,
	loadRegistrationConfig,
	parseRegistrationConfig,
} from "../../src/accounts/config.js";

const TEST_CONFIG_DIR = join(import.meta.dir, "../.test-config");

describe("config parsing", () => {
	describe("parseRegistrationConfig", () => {
		test("accepts valid registration config", () => {
			const result = parseRegistrationConfig({ registration_code: "abc-123" });
			expect(result.registration_code).toBe("abc-123");
		});

		test("rejects non-object", () => {
			expect(() => parseRegistrationConfig("string")).toThrow(ConfigError);
			expect(() => parseRegistrationConfig(null)).toThrow(ConfigError);
			expect(() => parseRegistrationConfig(42)).toThrow(ConfigError);
		});

		test("rejects missing registration_code", () => {
			expect(() => parseRegistrationConfig({})).toThrow("registration_code");
		});

		test("rejects empty registration_code", () => {
			expect(() => parseRegistrationConfig({ registration_code: "" })).toThrow("registration_code");
		});

		test("rejects non-string registration_code", () => {
			expect(() => parseRegistrationConfig({ registration_code: 123 })).toThrow(
				"registration_code",
			);
		});
	});
});

describe("config file loading", () => {
	beforeAll(async () => {
		await mkdir(TEST_CONFIG_DIR, { recursive: true });
	});

	afterAll(async () => {
		await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
	});

	describe("loadRegistrationConfig", () => {
		test("loads valid registration file", async () => {
			const filePath = join(TEST_CONFIG_DIR, "registration.json");
			await writeFile(filePath, JSON.stringify({ registration_code: "test-code" }));

			const result = await loadRegistrationConfig(filePath);
			expect(result.registration_code).toBe("test-code");
		});

		test("throws on missing file", async () => {
			await expect(
				loadRegistrationConfig(join(TEST_CONFIG_DIR, "nonexistent.json")),
			).rejects.toThrow(ConfigError);
		});

		test("throws on invalid JSON", async () => {
			const filePath = join(TEST_CONFIG_DIR, "bad-json.json");
			await writeFile(filePath, "not json {{{");

			await expect(loadRegistrationConfig(filePath)).rejects.toThrow("not valid JSON");
		});
	});
});
