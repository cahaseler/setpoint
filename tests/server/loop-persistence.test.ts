import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connectAccounts, resumeLoopConfig } from "../../src/index.js";
import { JobManager } from "../../src/server/job-manager.js";
import { LoopManager } from "../../src/server/loop-manager.js";
import { createMemoryDatabase } from "../../src/state/database.js";
import type { StateStore } from "../../src/state/store.js";
import { FakeLibManagedAccount, makeFakeLibManager } from "../dispatcher/lib-fakes.js";

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

	test("resumeLoopConfig resumes a persisted roaming-salvage config on restart", async () => {
		const options = {
			homeSystemId: "sol",
			homeStationPoiId: "sol_station",
			homeBaseId: "sol_base",
		};
		const loopManager = new LoopManager();
		await loopManager.saveLoopConfig("player-roamer", "roaming-salvage", options, tempDir);

		const account = new FakeLibManagedAccount({ playerId: "player-roamer", username: "Roamer" });
		const libManager = makeFakeLibManager([account]);
		const calls: Array<{ playerId: string; options: unknown }> = [];
		// Shadow the real start method so resume doesn't kick off an actual loop.
		loopManager.startRoamingSalvageLoop = ((playerId: string, opts: unknown) => {
			calls.push({ playerId, options: opts });
			return { running: true } as ReturnType<LoopManager["startRoamingSalvageLoop"]>;
		}) as LoopManager["startRoamingSalvageLoop"];

		const [config] = await LoopManager.loadLoopConfigs(tempDir);
		if (!config) throw new Error("expected a loaded config");
		resumeLoopConfig(loopManager, libManager, config);

		expect(calls.length).toBe(1);
		expect(calls[0]?.playerId).toBe("player-roamer");
		expect(calls[0]?.options).toEqual(options);
	});

	test("resumeLoopConfig logs and skips when the loop type is unknown", async () => {
		const loopManager = new LoopManager();
		const libManager = makeFakeLibManager([
			new FakeLibManagedAccount({ playerId: "player-x", username: "X" }),
		]);

		expect(() =>
			resumeLoopConfig(loopManager, libManager, {
				playerId: "player-x",
				type: "not-a-real-loop-type",
				options: {},
			}),
		).not.toThrow();
	});

	test("resumeLoopConfig logs and does not throw when the account is no longer connected", async () => {
		const loopManager = new LoopManager();
		const libManager = makeFakeLibManager([]);

		expect(() =>
			resumeLoopConfig(loopManager, libManager, {
				playerId: "player-gone",
				type: "roaming-salvage",
				options: {},
			}),
		).not.toThrow();
	});

	describe("connectAccounts", () => {
		test("resumes a persisted loop for its account as soon as it connects, without waiting for the rest of the fleet", async () => {
			const options = {
				homeSystemId: "sol",
				homeStationPoiId: "sol_station",
				homeBaseId: "sol_base",
			};
			const loopManager = new LoopManager();
			loopManager.setConfigDir(tempDir);
			await loopManager.saveLoopConfig("player-roamer", "roaming-salvage", options, tempDir);
			const calls: Array<{ playerId: string; options: unknown }> = [];
			loopManager.startRoamingSalvageLoop = ((playerId: string, opts: unknown) => {
				calls.push({ playerId, options: opts });
				return { running: true } as ReturnType<LoopManager["startRoamingSalvageLoop"]>;
			}) as LoopManager["startRoamingSalvageLoop"];

			const account = new FakeLibManagedAccount({ playerId: "player-roamer", username: "Roamer" });
			const manager = makeFakeLibManager([account]);
			const store = { getState: mock(() => null) } as unknown as StateStore;

			await connectAccounts(
				manager,
				store,
				{ loopManager, jobManager: new JobManager(createMemoryDatabase()) },
				tempDir,
			);

			expect(calls.length).toBe(1);
			expect(calls[0]?.playerId).toBe("player-roamer");
		});

		test("does not throw when a connected account has no player_id yet", async () => {
			const loopManager = new LoopManager();
			const ghost = new FakeLibManagedAccount({ username: "Ghost" }); // no playerId
			const manager = makeFakeLibManager([ghost]);
			const store = { getState: mock(() => null) } as unknown as StateStore;

			await expect(
				connectAccounts(
					manager,
					store,
					{ loopManager, jobManager: new JobManager(createMemoryDatabase()) },
					tempDir,
				),
			).resolves.toBeUndefined();
		});
	});
});
