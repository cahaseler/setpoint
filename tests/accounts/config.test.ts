import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	ConfigError,
	loadAccountConfigs,
	loadConfig,
	loadRegistrationConfig,
	parseAccountConfig,
	parseRegistrationConfig,
	saveAccountConfig,
} from "../../src/accounts/config.js";

const TEST_CONFIG_DIR = join(import.meta.dir, "../.test-config");
const TEST_ACCOUNTS_DIR = join(TEST_CONFIG_DIR, "accounts");

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

	describe("parseAccountConfig", () => {
		const validAccount = {
			username: "Player1",
			password: "pass-123",
			player_id: "uuid-abc",
		};

		test("accepts valid account config", () => {
			const result = parseAccountConfig(validAccount, "player1.json");
			expect(result.username).toBe("Player1");
			expect(result.password).toBe("pass-123");
			expect(result.player_id).toBe("uuid-abc");
		});

		test("rejects non-object", () => {
			expect(() => parseAccountConfig(null, "test.json")).toThrow(ConfigError);
		});

		test("rejects missing username", () => {
			expect(() => parseAccountConfig({ password: "p", player_id: "id" }, "test.json")).toThrow(
				"username",
			);
		});

		test("rejects empty username", () => {
			expect(() =>
				parseAccountConfig({ username: "", password: "p", player_id: "id" }, "test.json"),
			).toThrow("username");
		});

		test("rejects missing password", () => {
			expect(() => parseAccountConfig({ username: "u", player_id: "id" }, "test.json")).toThrow(
				"password",
			);
		});

		test("rejects missing player_id", () => {
			expect(() => parseAccountConfig({ username: "u", password: "p" }, "test.json")).toThrow(
				"player_id",
			);
		});

		test("includes filename in error message", () => {
			expect(() => parseAccountConfig({}, "my-file.json")).toThrow("my-file.json");
		});
	});
});

describe("config file loading", () => {
	beforeAll(async () => {
		await mkdir(TEST_ACCOUNTS_DIR, { recursive: true });
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

	describe("loadAccountConfigs", () => {
		test("loads all JSON files from directory", async () => {
			const dir = join(TEST_CONFIG_DIR, "accounts-valid");
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "player1.json"),
				JSON.stringify({ username: "P1", password: "pw1", player_id: "id1" }),
			);
			await writeFile(
				join(dir, "player2.json"),
				JSON.stringify({ username: "P2", password: "pw2", player_id: "id2" }),
			);

			const accounts = await loadAccountConfigs(dir);

			expect(accounts).toHaveLength(2);
			expect(accounts[0]?.username).toBe("P1");
			expect(accounts[1]?.username).toBe("P2");
		});

		test("ignores non-JSON files", async () => {
			const dir = join(TEST_CONFIG_DIR, "accounts-mixed");
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "player1.json"),
				JSON.stringify({ username: "P1", password: "pw1", player_id: "id1" }),
			);
			await writeFile(join(dir, "readme.txt"), "not a config");

			const accounts = await loadAccountConfigs(dir);
			expect(accounts).toHaveLength(1);
		});

		test("throws on nonexistent directory", async () => {
			await expect(loadAccountConfigs(join(TEST_CONFIG_DIR, "nope"))).rejects.toThrow(ConfigError);
		});

		test("throws on empty directory", async () => {
			const dir = join(TEST_CONFIG_DIR, "accounts-empty");
			await mkdir(dir, { recursive: true });

			await expect(loadAccountConfigs(dir)).rejects.toThrow("No account config files");
		});

		test("throws on invalid account file", async () => {
			const dir = join(TEST_CONFIG_DIR, "accounts-invalid");
			await mkdir(dir, { recursive: true });
			await writeFile(join(dir, "bad.json"), JSON.stringify({ username: "P1" }));

			await expect(loadAccountConfigs(dir)).rejects.toThrow("password");
		});
	});

	describe("loadConfig", () => {
		test("loads full config from directory", async () => {
			const dir = join(TEST_CONFIG_DIR, "full");
			const accountsDir = join(dir, "accounts");
			await mkdir(accountsDir, { recursive: true });
			await writeFile(
				join(dir, "registration.json"),
				JSON.stringify({ registration_code: "code-123" }),
			);
			await writeFile(
				join(accountsDir, "p1.json"),
				JSON.stringify({ username: "P1", password: "pw", player_id: "id1" }),
			);

			const config = await loadConfig(dir);

			expect(config.registration.registration_code).toBe("code-123");
			expect(config.accounts).toHaveLength(1);
			expect(config.accounts[0]?.username).toBe("P1");
		});
	});

	describe("saveAccountConfig", () => {
		test("saves account config to accounts subdirectory", async () => {
			const dir = join(TEST_CONFIG_DIR, "save-test");
			const config = { username: "TestBot", password: "secret", player_id: "p1" };

			const filePath = await saveAccountConfig(config, dir);
			expect(filePath).toContain("testbot.json");

			const raw = await readFile(filePath, "utf-8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			expect(parsed["username"]).toBe("TestBot");
			expect(parsed["password"]).toBe("secret");
			expect(parsed["player_id"]).toBe("p1");
		});

		test("slugifies username with special characters", async () => {
			const dir = join(TEST_CONFIG_DIR, "save-slug");
			const config = { username: "Captain Nova!", password: "pw", player_id: "p2" };

			const filePath = await saveAccountConfig(config, dir);
			expect(filePath).toContain("captain-nova.json");
		});

		test("creates accounts directory if missing", async () => {
			const dir = join(TEST_CONFIG_DIR, "save-missing-dir");
			const config = { username: "Bot", password: "pw", player_id: "p3" };

			const filePath = await saveAccountConfig(config, dir);
			const raw = await readFile(filePath, "utf-8");
			expect(raw).toContain("Bot");
		});
	});
});
