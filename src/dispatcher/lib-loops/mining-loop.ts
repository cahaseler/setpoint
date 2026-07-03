import type { GameState } from "@spacemolt/lib";
import type { StoredGameState } from "../../state/store.js";
import { createLogger } from "../../util/logger.js";
import type { GoalResult, LoopOptions, LoopResult } from "../goals.js";
import { LibMiningRun } from "../lib-compounds/mining-run.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { type LibGoalFactory, runLibLoop } from "../lib-loops.js";
import { LibMiningIteration } from "./mining-iteration.js";
import { checkHarvesterForPoi } from "./mining-precheck.js";

const log = createLogger("loop:mining");

/** Options for the MiningLoop. */
export interface MiningLoopOptions {
	/** System containing the mining belt. */
	miningSystemId: string;
	/** POI ID of the asteroid belt. */
	beltPoiId: string;
	/** System containing the sell station. */
	sellSystemId: string;
	/** POI ID of the sell station. */
	sellStationPoiId: string;
	/** Base ID to dock at for selling. */
	sellBaseId: string;
	/** Cargo fullness threshold for MineUntilFull. */
	fullThreshold?: number;
	/** Max mine attempts per run. */
	maxAttempts?: number;
	/** Whether to repair hull at the sell station each iteration. Defaults to false. */
	repair?: boolean;
	/** Where to deposit unsold cargo items. Defaults to "personal". */
	depositTarget?: "personal" | "faction";
	/** Skip market check and deposit all cargo directly without selling. */
	skipMarket?: boolean;
	/** When set to "faction", withdraws credits from the faction treasury if credits are low before refueling. */
	cashSource?: "faction";
	/** Minimum credit balance before withdrawing from storage. */
	minCredits?: number;
	/**
	 * When set, create sell orders for all cargo at this price instead of
	 * depositing to storage. Buy orders at or above this price fill immediately;
	 * remaining quantity is listed on the market at this price.
	 */
	listPrice?: number;
	/** Per-item sell prices keyed by item_id. Takes precedence over listPrice. */
	listPrices?: Record<string, number>;
	/**
	 * When true, "Resources depleted" mining failures are retried indefinitely
	 * without counting toward the consecutive failure limit. The loop waits
	 * retryDelayMs (default 30s) between attempts, allowing resources to regenerate.
	 */
	retryOnDepleted?: boolean;
	/**
	 * Extra fuel units to keep in reserve beyond the estimated round-trip cost.
	 * Covers intra-system travel and margin. Defaults to 0.
	 */
	minFuelReserve?: number;
	/** Loop control options (signal, maxIterations, shouldContinue). */
	loopOptions?: LoopOptions;
}

/**
 * Run a mining loop: repeatedly mine until cargo full → sell at station → repeat.
 *
 * Each iteration is a LibMiningIteration containing:
 * 1. Pre-flight round-trip fuel check (refuels at sell station if needed)
 * 2. LibMiningRun — travel to belt and mine until cargo full
 * 3. LibSellAtStation — travel to station, dock, sell all cargo (includes refuel)
 *
 * Returns when stopped, cancelled, or failed.
 */
export async function runMiningLoop(
	options: MiningLoopOptions,
	ctx: LibGoalContext,
): Promise<LoopResult> {
	log.info(`Starting mining loop: belt=${options.beltPoiId} → sell=${options.sellBaseId}`);

	const precheckResult = await checkHarvesterForPoi(
		{
			miningSystemId: options.miningSystemId,
			beltPoiId: options.beltPoiId,
			sellSystemId: options.sellSystemId,
			sellStationPoiId: options.sellStationPoiId,
			sellBaseId: options.sellBaseId,
		},
		ctx,
	);
	if (precheckResult !== null) return precheckResult;

	// Tracks depletion-then-sell behavior when retryOnDepleted is false.
	// "mining" = normal, "selling" = depletion hit, sell on next retry, "done" = sold, stop loop.
	let depletedPhase: "mining" | "selling" | "done" = "mining";

	const factory: LibGoalFactory = (_state: Readonly<GameState>): LibGoal => {
		// Re-computed each iteration so live option patches (via PATCH /loop) take effect immediately.
		const sellOptions = {
			systemId: options.sellSystemId,
			stationPoiId: options.sellStationPoiId,
			baseId: options.sellBaseId,
			...(options.repair !== undefined ? { repair: options.repair } : {}),
			...(options.depositTarget !== undefined ? { depositTarget: options.depositTarget } : {}),
			...(options.skipMarket !== undefined ? { skipMarket: options.skipMarket } : {}),
			...(options.cashSource !== undefined ? { cashSource: options.cashSource } : {}),
			...(options.minCredits !== undefined ? { minCredits: options.minCredits } : {}),
			...(options.listPrice !== undefined ? { listPrice: options.listPrice } : {}),
			...(options.listPrices !== undefined ? { listPrices: options.listPrices } : {}),
		};
		const sellPrepareOptions = {
			systemId: options.sellSystemId,
			poiId: options.sellStationPoiId,
			baseId: options.sellBaseId,
			...(options.cashSource !== undefined ? { cashSource: options.cashSource } : {}),
			...(options.minCredits !== undefined ? { minCredits: options.minCredits } : {}),
		};

		const phase = depletedPhase === "selling" ? "selling" : "mining";
		if (depletedPhase === "selling") {
			depletedPhase = "done";
		}
		return new LibMiningIteration({
			iterationName: "mining-iteration",
			miningPoiId: options.beltPoiId,
			runGoal: new LibMiningRun({
				systemId: options.miningSystemId,
				beltPoiId: options.beltPoiId,
				...(options.fullThreshold !== undefined ? { fullThreshold: options.fullThreshold } : {}),
				...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
			}),
			sellOptions,
			sellPrepareOptions,
			depletedPhase: phase,
			minFuelReserve: options.minFuelReserve ?? 0,
		});
	};

	const baseIgnoreFailure = options.loopOptions?.ignoreFailure;
	const ignoreFailure = (r: GoalResult): boolean => {
		if (r.message.includes("Resources depleted")) {
			if (!options.retryOnDepleted) {
				depletedPhase = "selling";
			}
			return true;
		}
		return baseIgnoreFailure?.(r) ?? false;
	};

	const baseShouldContinue = options.loopOptions?.shouldContinue;
	const shouldContinue = (i: number, state: StoredGameState): boolean => {
		if (depletedPhase === "done") return false;
		return baseShouldContinue ? baseShouldContinue(i, state) : true;
	};

	return runLibLoop(factory, ctx, {
		...options.loopOptions,
		ignoreFailure,
		shouldContinue,
	});
}
