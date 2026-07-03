import type { GameState } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { LoopOptions, LoopResult } from "../goals.js";
import { LibLootRun } from "../lib-compounds/loot-run.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { type LibGoalFactory, runLibLoop } from "../lib-loops.js";
import { LibMiningIteration } from "./mining-iteration.js";

const log = createLogger("loop:salvage");

/** Options for the SalvageLoop. */
export interface SalvageLoopOptions {
	/** System containing the salvage site. */
	salvageSystemId: string;
	/** POI ID of the salvage site. */
	salvagePoiId: string;
	/** System containing the sell station. */
	sellSystemId: string;
	/** POI ID of the sell station. */
	sellStationPoiId: string;
	/** Base ID to dock at for selling. */
	sellBaseId: string;
	/** Cargo fullness threshold for LootUntilFull. */
	fullThreshold?: number;
	/** Max loot attempts per run. */
	maxAttempts?: number;
	/** Where to deposit unsold cargo items. Defaults to "personal". */
	depositTarget?: "personal" | "faction";
	/** Whether to repair hull at the sell station each iteration. Defaults to false. */
	repair?: boolean;
	/** Skip market check and deposit all cargo directly without selling. */
	skipMarket?: boolean;
	/** When set to "faction", withdraws credits from the faction treasury if credits are low before refueling. */
	cashSource?: "faction";
	/** Minimum credit balance before withdrawing from storage. */
	minCredits?: number;
	/**
	 * Extra fuel units to keep in reserve beyond the estimated round-trip cost.
	 * Covers intra-system travel and margin. Defaults to 0.
	 */
	minFuelReserve?: number;
	/** Loop control options (signal, maxIterations, shouldContinue). */
	loopOptions?: LoopOptions;
}

/**
 * Run a salvage loop: repeatedly loot wrecks until cargo full → sell at station → repeat.
 *
 * Each iteration is a LibMiningIteration containing:
 * 1. Pre-flight round-trip fuel check (refuels at sell station if needed)
 * 2. LibLootRun — travel to salvage site and loot wrecks until cargo full (or all wrecks looted)
 * 3. LibSellAtStation — travel to station, dock, sell all cargo (includes refuel)
 *
 * Returns when stopped, cancelled, or failed.
 */
export function runSalvageLoop(
	options: SalvageLoopOptions,
	ctx: LibGoalContext,
): Promise<LoopResult> {
	log.info(`Starting salvage loop: poi=${options.salvagePoiId} → sell=${options.sellBaseId}`);

	// Re-computed each iteration so live option patches (via PATCH /loop) take effect immediately.
	const factory: LibGoalFactory = (_state: Readonly<GameState>): LibGoal => {
		const sellOptions = {
			systemId: options.sellSystemId,
			stationPoiId: options.sellStationPoiId,
			baseId: options.sellBaseId,
			...(options.repair !== undefined ? { repair: options.repair } : {}),
			...(options.depositTarget !== undefined ? { depositTarget: options.depositTarget } : {}),
			...(options.skipMarket !== undefined ? { skipMarket: options.skipMarket } : {}),
			...(options.cashSource !== undefined ? { cashSource: options.cashSource } : {}),
			...(options.minCredits !== undefined ? { minCredits: options.minCredits } : {}),
		};
		const sellPrepareOptions = {
			systemId: options.sellSystemId,
			poiId: options.sellStationPoiId,
			baseId: options.sellBaseId,
			...(options.cashSource !== undefined ? { cashSource: options.cashSource } : {}),
			...(options.minCredits !== undefined ? { minCredits: options.minCredits } : {}),
		};
		return new LibMiningIteration({
			iterationName: "salvage-iteration",
			miningPoiId: options.salvagePoiId,
			runGoal: new LibLootRun({
				systemId: options.salvageSystemId,
				salvagePoiId: options.salvagePoiId,
				...(options.fullThreshold !== undefined ? { fullThreshold: options.fullThreshold } : {}),
				...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
			}),
			sellOptions,
			sellPrepareOptions,
			depletedPhase: "mining",
			minFuelReserve: options.minFuelReserve ?? 0,
		});
	};

	return runLibLoop(factory, ctx, options.loopOptions);
}
