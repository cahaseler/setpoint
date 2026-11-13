import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberAccount } from "../../src/accounts/allowlist.js";

let dir: string;
const configPath = (): string => join(dir, "dispatcher.json");
const readConfig = async (): Promise<Record<string, unknown>> =>
	JSON.parse(await readFile(configPath(), "utf-8")) as Record<string, unknown>;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "allowlist-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("rememberAccount", () => {
	test("appends the username and keeps every other setting", async () => {
		await writeFile(
			configPath(),
			JSON.stringify({
				clerkApiKey: "ak_test",
				accountsFilter: { usernames: ["Alpha"], includeHidden: true },
			}),
		);

		expect(await rememberAccount(dir, "Bravo")).toBe(true);
		expect(await readConfig()).toEqual({
			clerkApiKey: "ak_test",
			accountsFilter: { usernames: ["Alpha", "Bravo"], includeHidden: true },
		});
	});

	test("does nothing when the account is already listed, in any case", async () => {
		await writeFile(configPath(), JSON.stringify({ accountsFilter: { usernames: ["ILC Tenon"] } }));

		expect(await rememberAccount(dir, "ilc tenon")).toBe(false);
		expect(await readConfig()).toEqual({ accountsFilter: { usernames: ["ILC Tenon"] } });
	});

	test("does nothing without a username allowlist, since every owned account connects", async () => {
		await writeFile(configPath(), JSON.stringify({ accountsFilter: { empires: ["solarian"] } }));

		expect(await rememberAccount(dir, "Bravo")).toBe(false);
		expect(await readConfig()).toEqual({ accountsFilter: { empires: ["solarian"] } });
	});

	test("does nothing when there is no config file", async () => {
		expect(await rememberAccount(dir, "Bravo")).toBe(false);
	});

	test("concurrent adds all land", async () => {
		await writeFile(configPath(), JSON.stringify({ accountsFilter: { usernames: [] } }));
		const names = ["A", "B", "C", "D", "E"];

		await Promise.all(names.map((n) => rememberAccount(dir, n)));

		const filter = (await readConfig())["accountsFilter"] as { usernames: string[] };
		expect([...filter.usernames].sort()).toEqual(names);
	});

	test("rejects on an unreadable config and still serves later calls", async () => {
		await writeFile(configPath(), "{ not json");
		await expect(rememberAccount(dir, "Bravo")).rejects.toThrow();

		await writeFile(configPath(), JSON.stringify({ accountsFilter: { usernames: [] } }));
		expect(await rememberAccount(dir, "Bravo")).toBe(true);
	});
});
