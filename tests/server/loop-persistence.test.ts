import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LoopManager } from "../../src/server/loop-manager.js";

const tempDir = join(import.meta.dir, "..", "..", "test-config-temp");

describe("loop-persistence", () => {
	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("saveLoopConfig creates file with correct content", async () => {
		const manager = new LoopManager();
		const options = { miningSystemId: "sol", beltPoiId: "belt_1" };

		await manager.saveLoopConfig("player-abc", "mining", options, tempDir);

		const filePath = join(tempDir, "loops", "player-abc.json");
		const raw = await readFile(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;

		expect(parsed["type"]).toBe("mining");
		expect(parsed["options"]).toEqual(options);
	});

	test("deleteLoopConfig removes file", async () => {
		const manager = new LoopManager();
		await manager.saveLoopConfig("player-abc", "mining", {}, tempDir);

		const filePath = join(tempDir, "loops", "player-abc.json");
		// Confirm it exists first
		const raw = await readFile(filePath, "utf-8");
		expect(raw.length).toBeGreaterThan(0);

		await manager.deleteLoopConfig("player-abc", tempDir);

		let threw = false;
		try {
			await readFile(filePath, "utf-8");
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	test("deleteLoopConfig does not throw if file missing", async () => {
		const manager = new LoopManager();
		// No file saved — should not throw
		await expect(manager.deleteLoopConfig("no-such-player", tempDir)).resolves.toBeUndefined();
	});

	test("loadLoopConfigs reads all saved configs", async () => {
		const manager = new LoopManager();

		const options1 = { miningSystemId: "sol", beltPoiId: "belt_1" };
		const options2 = {
			systemId: "alpha",
			stationPoiId: "alpha_station",
			baseId: "alpha_base",
			recipeId: "iron_bar",
		};

		await manager.saveLoopConfig("player-1", "mining", options1, tempDir);
		await manager.saveLoopConfig("player-2", "crafting", options2, tempDir);

		const configs = await LoopManager.loadLoopConfigs(tempDir);

		expect(configs.length).toBe(2);

		const mining = configs.find((c) => c.playerId === "player-1");
		expect(mining).toBeDefined();
		expect(mining?.type).toBe("mining");
		expect(mining?.options).toEqual(options1);

		const crafting = configs.find((c) => c.playerId === "player-2");
		expect(crafting).toBeDefined();
		expect(crafting?.type).toBe("crafting");
		expect(crafting?.options).toEqual(options2);
	});

	test("loadLoopConfigs returns empty array when no loops directory", async () => {
		// tempDir doesn't exist yet — no loops subdir either
		const configs = await LoopManager.loadLoopConfigs(tempDir);
		expect(configs).toEqual([]);
	});

	test("loadLoopConfigs skips non-json files", async () => {
		const loopsDir = join(tempDir, "loops");
		await mkdir(loopsDir, { recursive: true });

		// Write a valid config and a non-json file
		await writeFile(
			join(loopsDir, "player-1.json"),
			JSON.stringify({ type: "mining", options: {} }),
			"utf-8",
		);
		await writeFile(join(loopsDir, "README.txt"), "not json", "utf-8");

		const configs = await LoopManager.loadLoopConfigs(tempDir);

		expect(configs.length).toBe(1);
		expect(configs[0]?.playerId).toBe("player-1");
	});

	test("loadLoopConfigs skips invalid json", async () => {
		const loopsDir = join(tempDir, "loops");
		await mkdir(loopsDir, { recursive: true });

		await writeFile(join(loopsDir, "bad-player.json"), "{ not valid json }", "utf-8");
		await writeFile(
			join(loopsDir, "good-player.json"),
			JSON.stringify({ type: "hauling", options: { source: "sol" } }),
			"utf-8",
		);

		const configs = await LoopManager.loadLoopConfigs(tempDir);

		expect(configs.length).toBe(1);
		expect(configs[0]?.playerId).toBe("good-player");
		expect(configs[0]?.type).toBe("hauling");
	});
});
