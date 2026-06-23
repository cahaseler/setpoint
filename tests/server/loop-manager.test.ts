import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ManagedAccount } from "../../src/accounts/manager.js";
import type { GameEndpoints } from "../../src/api/endpoints.js";
import { LoopManager, buildGoalContext } from "../../src/server/loop-manager.js";
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
import type { StoredGameState } from "../../src/state/store.js";

const TEST_CONFIG_DIR = join(import.meta.dir, "..", "..", "test-config-temp", "loop-mgr");

// ── Helpers ──────────────────────────────────────────────────────────

function makeState(overrides: Partial<StoredGameState> = {}): StoredGameState {
	return {
		player: undefined,
		ship: undefined,
		cargo: undefined,
		location: undefined,
		modules: undefined,
		skills: undefined,
		missions: undefined,
		queue: undefined,
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeStore(state: StoredGameState | null = null) {
	return {
		getState: mock(() => state),
		getSection: mock(() => undefined),
		upsertSection: mock(() => {}),
		deleteAccount: mock(() => {}),
		getAllAccountIds: mock(() => []),
	};
}

function makeAccount(playerId = "p1"): ManagedAccount {
	return {
		config: { username: "TestPlayer", password: "pass", player_id: playerId },
		session: {} as ManagedAccount["session"],
		endpoints: {
			getState: mock(() => Promise.resolve({} as ReturnType<GameEndpoints["getState"]>)),
		} as unknown as GameEndpoints,
	};
}

// ── buildGoalContext ─────────────────────────────────────────────────

describe("buildGoalContext", () => {
	test("returns context with existing state from store", () => {
		const state = makeState({ player: { credits: 100 } as StoredGameState["player"] });
		const store = makeStore(state);
		const account = makeAccount();

		const ctx = buildGoalContext(account, store as never);
		expect(ctx.endpoints).toBe(account.endpoints);
		expect(ctx.state).toBe(state);
	});

	test("returns empty state when store has none", () => {
		const store = makeStore(null);
		const account = makeAccount();

		const ctx = buildGoalContext(account, store as never);
		expect(ctx.state.player).toBeUndefined();
		expect(ctx.state.updatedAt).toBeDefined();
	});

	test("refreshState returns the cached store state without a live getState (stationary)", async () => {
		const freshState = makeState({ player: { credits: 999 } as StoredGameState["player"] });
		const store = makeStore(freshState);
		const account = makeAccount();
		const ctx = buildGoalContext(account, store as never);

		const refresh = ctx.refreshState;
		if (!refresh) throw new Error("refreshState should be defined");
		const refreshed = await refresh();

		// The mutation-derived store is trusted — no live get_state call.
		expect(account.endpoints.getState).not.toHaveBeenCalled();
		expect(refreshed).toBe(freshState);
	});

	test("refreshState falls back to a live getState when the store is empty (cold start)", async () => {
		const store = makeStore(null);
		const account = makeAccount();

		const ctx = buildGoalContext(account, store as never);

		const refresh = ctx.refreshState;
		if (!refresh) throw new Error("refreshState should be defined");
		await expect(refresh()).rejects.toThrow("No state available after refresh");
		expect(account.endpoints.getState).toHaveBeenCalledTimes(1);
	});

	test("refreshState hits getState and waits when the cached state is mid-transit", async () => {
		const inTransit = makeState({
			location: { in_transit: true } as StoredGameState["location"],
		});
		const arrived = makeState({
			location: { in_transit: false } as StoredGameState["location"],
		});
		let arrivedNow = false;
		const store = {
			...makeStore(null),
			getState: mock(() => (arrivedNow ? arrived : inTransit)),
		};
		const account = makeAccount();
		const getStateMock = mock(() => {
			arrivedNow = true;
			return Promise.resolve({} as ReturnType<GameEndpoints["getState"]>);
		});
		account.endpoints = { getState: getStateMock } as unknown as GameEndpoints;
		const ctx = buildGoalContext(account, store as never);

		const refresh = ctx.refreshState;
		if (!refresh) throw new Error("refreshState should be defined");
		const refreshed = await refresh();

		// Mid-transit: must hit the wire and wait for arrival.
		expect(getStateMock).toHaveBeenCalled();
		expect(refreshed).toBe(arrived);
	});
});

// ── LoopManager ──────────────────────────────────────────────────────

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
	let store: ReturnType<typeof makeStore>;
	let account: ManagedAccount;

	beforeEach(() => {
		manager = new LoopManager();
		store = makeStore(makeState());
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
		const status = manager.startMiningLoop("p1", options, account, store as never);
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
		manager.startMiningLoop("p1", options, account, store as never);
		expect(() => manager.startMiningLoop("p1", options, account, store as never)).toThrow(
			"already running",
		);
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
		const status = manager.startEnhancedMiningLoop("p1", options, account, store as never);
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
		manager.startEnhancedMiningLoop("p1", options, account, store as never);
		expect(() => manager.startEnhancedMiningLoop("p1", options, account, store as never)).toThrow(
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
		const status = manager.startSalvageLoop("p1", options, account, store as never);
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
		manager.startSalvageLoop("p1", options, account, store as never);
		expect(() => manager.startSalvageLoop("p1", options, account, store as never)).toThrow(
			"already running",
		);
	});

	// Trading

	test("startTradingLoop returns running LoopStatus", () => {
		const options: TradingLoopApiOptions = {
			buyStation: { systemId: "sol", poiId: "buy-station", baseId: "buy-base" },
			sellStation: { systemId: "sol", stationPoiId: "sell-station", baseId: "sell-base" },
			items: [{ itemId: "iron_ore", maxBuyPrice: 10, minSellPrice: 20 }],
			maxIterations: 0,
		};
		const status = manager.startTradingLoop("p1", options, account, store as never);
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
		manager.startTradingLoop("p1", options, account, store as never);
		expect(() => manager.startTradingLoop("p1", options, account, store as never)).toThrow(
			"already running",
		);
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
		const status = manager.startHaulingLoop("p1", options, account, store as never);
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
		manager.startHaulingLoop("p1", options, account, store as never);
		expect(() => manager.startHaulingLoop("p1", options, account, store as never)).toThrow(
			"already running",
		);
	});

	// Storage transfer

	test("startStorageTransferLoop returns running LoopStatus", () => {
		const options: StorageTransferLoopApiOptions = {
			systemId: "sol",
			stationPoiId: "sol-station",
			baseId: "sol-base",
			maxIterations: 0,
		};
		const status = manager.startStorageTransferLoop("p1", options, account, store as never);
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
		manager.startStorageTransferLoop("p1", options, account, store as never);
		expect(() => manager.startStorageTransferLoop("p1", options, account, store as never)).toThrow(
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
		const status = manager.startExplorationLoop("p1", options, account, store as never);
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
		manager.startExplorationLoop("p1", options, account, store as never);
		expect(() => manager.startExplorationLoop("p1", options, account, store as never)).toThrow(
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
		const status = manager.startGuardLoop("p1", options, account, store as never);
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
		manager.startGuardLoop("p1", options, account, store as never);
		expect(() => manager.startGuardLoop("p1", options, account, store as never)).toThrow(
			"already running",
		);
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
		manager.startMiningLoop("p1", options, account, store as never);
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
		manager.startTradingLoop("p1", options, account, store as never);
		// Promise is still pending (resolves on next microtask) → abortLoop returns true
		expect(manager.abortLoop("p1")).toBe(true);
	});

	test("abortLoop returns true and cleans up completed loop", async () => {
		// Use trading (no getPoi precheck, no API calls before runLoop)
		const options: TradingLoopApiOptions = {
			buyStation: { systemId: "sol", poiId: "buy-station", baseId: "buy-base" },
			sellStation: { systemId: "sol", stationPoiId: "sell-station", baseId: "sell-base" },
			items: [{ itemId: "iron_ore", maxBuyPrice: 10, minSellPrice: 20 }],
			maxIterations: 0,
		};
		manager.startTradingLoop("p1", options, account, store as never);
		// Wait for the loop to complete (0 iterations resolves immediately as microtask)
		await new Promise<void>((r) => setTimeout(r, 10));
		expect(manager.isRunning("p1")).toBe(false);
		expect(manager.abortLoop("p1")).toBe(true);
		// Cleaned up — status now undefined
		expect(manager.getStatus("p1")).toBeUndefined();
	});
});

// ── migrateLoopConfigs / migrateJsonValue ────────────────────────────

describe("migrateLoopConfigs", () => {
	let manager: LoopManager;

	beforeEach(async () => {
		manager = new LoopManager();
		await mkdir(join(TEST_CONFIG_DIR, "loops"), { recursive: true });
	});

	afterEach(async () => {
		await rm(TEST_CONFIG_DIR, { recursive: true, force: true });
	});

	test("returns empty array when no loop configs exist", async () => {
		const results = await manager.migrateLoopConfigs(TEST_CONFIG_DIR, { old_id: "new_id" });
		expect(results).toHaveLength(0);
	});

	test("migrates string values in loop config", async () => {
		const config = {
			type: "mining",
			options: {
				miningSystemId: "old-sys",
				beltPoiId: "old-belt",
				sellSystemId: "sol",
				sellStationPoiId: "sol-station",
				sellBaseId: "sol-base",
			},
		};
		await writeFile(
			join(TEST_CONFIG_DIR, "loops", "player1.json"),
			JSON.stringify(config),
			"utf-8",
		);

		const results = await manager.migrateLoopConfigs(TEST_CONFIG_DIR, {
			"old-sys": "new-sys",
			"old-belt": "new-belt",
		});

		expect(results).toHaveLength(1);
		const result = results[0];
		expect(result).toBeDefined();
		expect(result?.playerId).toBe("player1");
		expect(result?.changed).toBe(true);
		expect(result?.changes).toHaveLength(2);
		expect(result?.changes.some((c) => c.from === "old-sys" && c.to === "new-sys")).toBe(true);
		expect(result?.changes.some((c) => c.from === "old-belt" && c.to === "new-belt")).toBe(true);
	});

	test("reports unchanged when no IDs match", async () => {
		const config = {
			type: "mining",
			options: {
				miningSystemId: "sol",
				beltPoiId: "belt-1",
				sellSystemId: "sol",
				sellStationPoiId: "sol-station",
				sellBaseId: "sol-base",
			},
		};
		await writeFile(
			join(TEST_CONFIG_DIR, "loops", "player1.json"),
			JSON.stringify(config),
			"utf-8",
		);

		const results = await manager.migrateLoopConfigs(TEST_CONFIG_DIR, { "old-id": "new-id" });

		expect(results).toHaveLength(1);
		expect(results[0]?.changed).toBe(false);
		expect(results[0]?.changes).toHaveLength(0);
	});

	test("migrates string values inside arrays", async () => {
		const config = {
			type: "enhanced-mining",
			options: {
				miningSystemId: "sol",
				beltPoiId: "belt-1",
				sellSystemId: "sol",
				sellStationPoiId: "sol-station",
				sellBaseId: "sol-base",
				junkItemIds: ["old-junk-1", "old-junk-2"],
			},
		};
		await writeFile(
			join(TEST_CONFIG_DIR, "loops", "player1.json"),
			JSON.stringify(config),
			"utf-8",
		);

		const results = await manager.migrateLoopConfigs(TEST_CONFIG_DIR, {
			"old-junk-1": "new-junk-1",
		});

		expect(results[0]?.changed).toBe(true);
		expect(results[0]?.changes[0]?.from).toBe("old-junk-1");
		expect(results[0]?.changes[0]?.to).toBe("new-junk-1");
	});

	test("handles multiple player configs independently", async () => {
		const config1 = {
			type: "mining",
			options: {
				miningSystemId: "old-sys",
				beltPoiId: "b1",
				sellSystemId: "s",
				sellStationPoiId: "sp",
				sellBaseId: "sb",
			},
		};
		const config2 = {
			type: "mining",
			options: {
				miningSystemId: "sol",
				beltPoiId: "b2",
				sellSystemId: "s",
				sellStationPoiId: "sp",
				sellBaseId: "sb",
			},
		};
		await writeFile(join(TEST_CONFIG_DIR, "loops", "p1.json"), JSON.stringify(config1), "utf-8");
		await writeFile(join(TEST_CONFIG_DIR, "loops", "p2.json"), JSON.stringify(config2), "utf-8");

		const results = await manager.migrateLoopConfigs(TEST_CONFIG_DIR, { "old-sys": "new-sys" });

		expect(results).toHaveLength(2);
		const p1Result = results.find((r) => r.playerId === "p1");
		const p2Result = results.find((r) => r.playerId === "p2");
		expect(p1Result?.changed).toBe(true);
		expect(p2Result?.changed).toBe(false);
	});
});
