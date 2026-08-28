import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CombatModeStore, DEFAULT_COMBAT_MODE } from "../../src/combat/combat-mode-store.js";

const tempDir = join(import.meta.dir, "..", "..", "test-config-temp-combat-mode");

describe("CombatModeStore", () => {
	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("get() defaults to flee for an account never set", async () => {
		const store = await CombatModeStore.load(tempDir);
		expect(store.get("unset-player")).toBe(DEFAULT_COMBAT_MODE);
		expect(store.get("unset-player")).toBe("flee");
	});

	test("set() persists to disk and get() reflects it immediately", async () => {
		const store = await CombatModeStore.load(tempDir);
		await store.set("player-1", "external");

		expect(store.get("player-1")).toBe("external");

		const raw = await readFile(join(tempDir, "combat-modes", "player-1.json"), "utf-8");
		expect(JSON.parse(raw)).toEqual({ mode: "external" });
	});

	test("load() rehydrates a previously persisted mode after a restart", async () => {
		const first = await CombatModeStore.load(tempDir);
		await first.set("player-1", "external");

		const second = await CombatModeStore.load(tempDir);
		expect(second.get("player-1")).toBe("external");
	});

	test("load() returns an empty store when no combat-modes directory exists", async () => {
		const store = await CombatModeStore.load(tempDir);
		expect(store.get("anyone")).toBe("flee");
	});

	test("load() skips an invalid mode and logs a warning, not a crash", async () => {
		const dir = join(tempDir, "combat-modes");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "bad-player.json"), JSON.stringify({ mode: "berserk" }));

		const store = await CombatModeStore.load(tempDir);
		expect(store.get("bad-player")).toBe("flee");
	});

	test("clear() removes the override and deletes the file", async () => {
		const store = await CombatModeStore.load(tempDir);
		await store.set("player-1", "external");
		await store.clear("player-1");

		expect(store.get("player-1")).toBe("flee");

		let threw = false;
		try {
			await readFile(join(tempDir, "combat-modes", "player-1.json"), "utf-8");
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	test("clear() does not throw when no override was ever set", async () => {
		const store = await CombatModeStore.load(tempDir);
		await expect(store.clear("never-set")).resolves.toBeUndefined();
	});
});
