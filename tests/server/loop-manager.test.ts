import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopManager } from "../../src/server/loop-manager.js";
import type {
	EnhancedMiningLoopApiOptions,
	ExplorationLoopApiOptions,
	GuardLoopApiOptions,
	HaulingLoopApiOptions,
	MiningLoopApiOptions,
	SalvageLoopApiOptions,
	StorageTransferLoopApiOptions,
	TradingLoopApiOptions,
} from "../../src/server/loop-manager.js";
import { FakeLibManagedAccount } from "../dispatcher/lib-fakes.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeAccount(playerId = "p1"): FakeLibManagedAccount {
	return new FakeLibManagedAccount({ playerId, username: "TestPlayer" });
}

describe("LoopManager", () => {
	let manager: LoopManager;

	beforeEach(() => {
		manager = new LoopManager();
	});

	test("isRunning returns false for unknown account", () => {
		expect(manager.isRunning("unknown")).toBe(false);
	});

	test("getStatus returns undefined for unknown account", () => {
		expect(manager.getStatus("unknown")).toBeUndefined();
	});

	test("abortLoop returns false for unknown account", () => {
		expect(manager.abortLoop("unknown")).toBe(false);
	});
});

// ── start*Loop methods ───────────────────────────────────────────────

describe("LoopManager start*Loop methods", () => {
	let manager: LoopManager;
	let account: FakeLibManagedAccount;

	beforeEach(() => {
		manager = new LoopManager();
		account = makeAccount("p1");
	});

	// Mining

	test("startMiningLoop returns running LoopStatus", () => {
		const options: MiningLoopApiOptions = {
			miningSystemId: "sol",
			beltPoiId: "belt-1",
			sellSystemId: "sol",
			sellStationPoiId: "sol-station",
			sellBaseId: "sol-base",
			maxIterations: 0,
		};
		const status = manager.startMiningLoop("p1", options, () => account);
		expect(status.type).toBe("mining");
		expect(status.running).toBe(true);
		expect(manager.isRunning("p1")).toBe(true);
	});

	test("startMiningLoop throws when loop already running", () => {
		const options: MiningLoopApiOptions = {
			miningSystemId: "sol",
			beltPoiId: "belt-1",
			sellSystemId: "sol",
			sellStationPoiId: "sol-station",
			sellBaseId: "sol-base",
		};
		manager.startMiningLoop("p1", options, () => account);
		expect(() => manager.startMiningLoop("p1", options, () => account)).toThrow("already running");
	});

	// Enhanced mining

	test("startEnhancedMiningLoop returns running LoopStatus", () => {
		const options: EnhancedMiningLoopApiOptions = {
			miningSystemId: "sol",
			beltPoiId: "belt-1",
			sellSystemId: "sol",
			sellStationPoiId: "sol-station",
			sellBaseId: "sol-base",
			junkItemIds: ["rock", "debris"],
			maxIterations: 0,
		};
		const status = manager.startEnhancedMiningLoop("p1", options, () => account);
		expect(status.type).toBe("enhanced-mining");
		expect(status.running).toBe(true);
		expect(manager.isRunning("p1")).toBe(true);
	});

	test("startEnhancedMiningLoop throws when loop already running", () => {
		const options: EnhancedMiningLoopApiOptions = {
			miningSystemId: "sol",
			beltPoiId: "belt-1",
			sellSystemId: "sol",
			sellStationPoiId: "sol-station",
			sellBaseId: "sol-base",
			junkItemIds: [],
		};
		manager.startEnhancedMiningLoop("p1", options, () => account);
		expect(() => manager.startEnhancedMiningLoop("p1", options, () => account)).toThrow(
			"already running",
		);
	});

	// Salvage

	test("startSalvageLoop returns running LoopStatus", () => {
		const options: SalvageLoopApiOptions = {
			salvageSystemId: "sol",
			salvagePoiId: "wreck-field",
			sellSystemId: "sol",
			sellStationPoiId: "sol-station",
			sellBaseId: "sol-base",
			maxIterations: 0,
		};
		const status = manager.startSalvageLoop("p1", options, () => account);
		expect(status.type).toBe("salvage");
		expect(status.running).toBe(true);
		expect(manager.isRunning("p1")).toBe(true);
	});

	test("startSalvageLoop throws when loop already running", () => {
		const options: SalvageLoopApiOptions = {
			salvageSystemId: "sol",
			salvagePoiId: "wreck-field",
			sellSystemId: "sol",
			sellStationPoiId: "sol-station",
			sellBaseId: "sol-base",
		};
		manager.startSalvageLoop("p1", options, () => account);
		expect(() => manager.startSalvageLoop("p1", options, () => account)).toThrow("already running");
	});

	// Trading

	test("startTradingLoop returns running LoopStatus", () => {
		const options: TradingLoopApiOptions = {
			buyStation: { systemId: "sol", poiId: "buy-station", baseId: "buy-base" },
			sellStation: { systemId: "sol", stationPoiId: "sell-station", baseId: "sell-base" },
			items: [{ itemId: "iron_ore", maxBuyPrice: 10, minSellPrice: 20 }],
			maxIterations: 0,
		};
		const status = manager.startTradingLoop("p1", options, () => account);
		expect(status.type).toBe("trading");
		expect(status.running).toBe(true);
		expect(manager.isRunning("p1")).toBe(true);
	});

	test("startTradingLoop throws when loop already running", () => {
		const options: TradingLoopApiOptions = {
			buyStation: { systemId: "sol", poiId: "buy-station", baseId: "buy-base" },
			sellStation: { systemId: "sol", stationPoiId: "sell-station", baseId: "sell-base" },
			items: [{ itemId: "iron_ore", maxBuyPrice: 10, minSellPrice: 20 }],
		};
		manager.startTradingLoop("p1", options, () => account);
		expect(() => manager.startTradingLoop("p1", options, () => account)).toThrow("already running");
	});

	// Hauling

	test("startHaulingLoop returns running LoopStatus", () => {
		const options: HaulingLoopApiOptions = {
			source: {
				systemId: "sol",
				poiId: "src-station",
				baseId: "src-base",
				type: "personal-storage",
				items: [{ itemId: "iron_ore" }],
			},
			destination: {
				systemId: "sol",
				poiId: "dst-station",
				baseId: "dst-base",
				type: "faction-storage",
			},
			maxIterations: 0,
		};
		const status = manager.startHaulingLoop("p1", options, () => account);
		expect(status.type).toBe("hauling");
		expect(status.running).toBe(true);
		expect(manager.isRunning("p1")).toBe(true);
	});

	test("startHaulingLoop throws when loop already running", () => {
		const options: HaulingLoopApiOptions = {
			source: {
				systemId: "sol",
				poiId: "src-station",
				baseId: "src-base",
				type: "market",
				items: [{ itemId: "iron_ore" }],
			},
			destination: {
				systemId: "sol",
				poiId: "dst-station",
				baseId: "dst-base",
				type: "personal-storage",
			},
		};
		manager.startHaulingLoop("p1", options, () => account);
		expect(() => manager.startHaulingLoop("p1", options, () => account)).toThrow("already running");
	});

	// Storage transfer

	test("startStorageTransferLoop returns running LoopStatus", () => {
		const options: StorageTransferLoopApiOptions = {
			systemId: "sol",
			stationPoiId: "sol-station",
			baseId: "sol-base",
			maxIterations: 0,
		};
		const status = manager.startStorageTransferLoop("p1", options, () => account);
		expect(status.type).toBe("storage-transfer");
		expect(status.running).toBe(true);
		expect(manager.isRunning("p1")).toBe(true);
	});

	test("startStorageTransferLoop throws when loop already running", () => {
		const options: StorageTransferLoopApiOptions = {
			systemId: "sol",
			stationPoiId: "sol-station",
			baseId: "sol-base",
		};
		manager.startStorageTransferLoop("p1", options, () => account);
		expect(() => manager.startStorageTransferLoop("p1", options, () => account)).toThrow(
			"already running",
		);
	});

	// Exploration

	test("startExplorationLoop returns running LoopStatus", () => {
		const options: ExplorationLoopApiOptions = {
			systemId: "sol",
			stationPoiId: "sol-station",
			baseId: "sol-base",
			maxIterations: 0,
		};
		const status = manager.startExplorationLoop("p1", options, () => account);
		expect(status.type).toBe("exploration");
		expect(status.running).toBe(true);
		expect(manager.isRunning("p1")).toBe(true);
	});

	test("startExplorationLoop throws when loop already running", () => {
		const options: ExplorationLoopApiOptions = {
			systemId: "sol",
			stationPoiId: "sol-station",
			baseId: "sol-base",
		};
		manager.startExplorationLoop("p1", options, () => account);
		expect(() => manager.startExplorationLoop("p1", options, () => account)).toThrow(
			"already running",
		);
	});

	// Guard

	test("startGuardLoop returns running LoopStatus", () => {
		const options: GuardLoopApiOptions = {
			homeSystemId: "sol",
			homeStationPoiId: "sol-station",
			homeBaseId: "sol-base",
			guardSystemId: "frontier",
			guardPoiId: "belt-1",
			maxIterations: 0,
		};
		const status = manager.startGuardLoop("p1", options, () => account);
		expect(status.type).toBe("guard");
		expect(status.running).toBe(true);
		expect(manager.isRunning("p1")).toBe(true);
	});

	test("startGuardLoop throws when loop already running", () => {
		const options: GuardLoopApiOptions = {
			homeSystemId: "sol",
			homeStationPoiId: "sol-station",
			homeBaseId: "sol-base",
			guardSystemId: "frontier",
			guardPoiId: "belt-1",
		};
		manager.startGuardLoop("p1", options, () => account);
		expect(() => manager.startGuardLoop("p1", options, () => account)).toThrow("already running");
	});

	// getStatus while running

	test("getStatus returns running=true immediately after starting", () => {
		const options: MiningLoopApiOptions = {
			miningSystemId: "sol",
			beltPoiId: "belt-1",
			sellSystemId: "sol",
			sellStationPoiId: "sol-station",
			sellBaseId: "sol-base",
			maxIterations: 0,
		};
		manager.startMiningLoop("p1", options, () => account);
		const status = manager.getStatus("p1");
		expect(status).toBeDefined();
		expect(status?.running).toBe(true);
		expect(status?.type).toBe("mining");
		expect(typeof status?.startedAt).toBe("string");
	});

	// abortLoop

	test("abortLoop returns false when no loop exists", () => {
		expect(manager.abortLoop("p1")).toBe(false);
	});

	test("abortLoop returns true and signals running loop", () => {
		// Use trading (no getPoi precheck, no API calls before runLoop)
		const options: TradingLoopApiOptions = {
			buyStation: { systemId: "sol", poiId: "buy-station", baseId: "buy-base" },
			sellStation: { systemId: "sol", stationPoiId: "sell-station", baseId: "sell-base" },
			items: [{ itemId: "iron_ore", maxBuyPrice: 10, minSellPrice: 20 }],
			maxIterations: 0,
		};
		manager.startTradingLoop("p1", options, () => account);
		// Promise is still pending (resolves on next microtask) → abortLoop returns true
		expect(manager.abortLoop("p1")).toBe(true);
	});

	test("getStatus reports stopping=true while an aborted loop's promise hasn't settled yet", () => {
		// Regression: abortLoop() is non-blocking, so a caller polling getStatus()
		// immediately after can still see running=true with no way to tell an
		// abort was already requested apart from a fresh, untouched loop.
		const options: TradingLoopApiOptions = {
			buyStation: { systemId: "sol", poiId: "buy-station", baseId: "buy-base" },
			sellStation: { systemId: "sol", stationPoiId: "sell-station", baseId: "sell-base" },
			items: [{ itemId: "iron_ore", maxBuyPrice: 10, minSellPrice: 20 }],
			maxIterations: 0,
		};
		manager.startTradingLoop("p1", options, () => account);
		expect(manager.getStatus("p1")?.stopping).toBeUndefined();
		manager.abortLoop("p1");
		const status = manager.getStatus("p1");
		expect(status?.running).toBe(true);
		expect(status?.stopping).toBe(true);
	});

	test("abortLoop returns true and cleans up completed loop", async () => {
		// Use trading (no getPoi precheck, no API calls before runLoop)
		const options: TradingLoopApiOptions = {
			buyStation: { systemId: "sol", poiId: "buy-station", baseId: "buy-base" },
			sellStation: { systemId: "sol", stationPoiId: "sell-station", baseId: "sell-base" },
			items: [{ itemId: "iron_ore", maxBuyPrice: 10, minSellPrice: 20 }],
			maxIterations: 0,
		};
		manager.startTradingLoop("p1", options, () => account);
		// Wait for the loop to complete (0 iterations resolves immediately as microtask)
		await new Promise<void>((r) => setTimeout(r, 10));
		expect(manager.isRunning("p1")).toBe(false);
		expect(manager.abortLoop("p1")).toBe(true);
		// Cleaned up — status now undefined
		expect(manager.getStatus("p1")).toBeUndefined();
	});
});

// ── Persisted config lifetime ────────────────────────────────────────

describe("persisted loop config lifetime", () => {
	let manager: LoopManager;
	let configDir: string;

	const options: MiningLoopApiOptions = {
		miningSystemId: "sol",
		beltPoiId: "belt-1",
		sellSystemId: "sol",
		sellStationPoiId: "sol-station",
		sellBaseId: "sol-base",
	};

	beforeEach(async () => {
		manager = new LoopManager();
		configDir = await mkdtemp(join(tmpdir(), "setpoint-loop-cfg-"));
		manager.setConfigDir(configDir);
	});

	afterEach(async () => {
		await rm(configDir, { recursive: true, force: true });
	});

	const configPath = (playerId: string): string => join(configDir, "loops", `${playerId}.json`);

	/** Wait for the loop to leave the active map, i.e. its promise settled. */
	async function settle(playerId: string): Promise<void> {
		for (let i = 0; i < 200 && manager.isRunning(playerId); i++) {
			await Bun.sleep(10);
		}
		// cleanup() deletes in a floating promise after the loop settles.
		await Bun.sleep(50);
	}

	test("a loop aborted on shutdown keeps its config so a restart resumes it", async () => {
		// handleStartLoop persists the config; the manager's start methods don't.
		await manager.saveLoopConfig("p1", "mining", { ...options }, configDir);
		manager.startMiningLoop("p1", options, () => makeAccount("p1"));
		expect(await Bun.file(configPath("p1")).exists()).toBe(true);

		// Exactly what stopAll() does for every loop on shutdown.
		manager.abortLoop("p1");
		await settle("p1");

		expect(await Bun.file(configPath("p1")).exists()).toBe(true);
	});

	test("a loop that ends on its own terms deletes its config", async () => {
		await manager.saveLoopConfig("p2", "mining", { ...options }, configDir);
		manager.startMiningLoop("p2", { ...options, maxIterations: 0 }, () => makeAccount("p2"));
		await settle("p2");

		expect(await Bun.file(configPath("p2")).exists()).toBe(false);
	});
});
