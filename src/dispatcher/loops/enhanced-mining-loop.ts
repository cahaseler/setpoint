import type { StoredGameState } from "../../state/store.js";
import { createLogger } from "../../util/logger.js";
import { EnhancedMiningRun } from "../compounds/enhanced-mining-run.js";
import type { GoalContext, GoalResult, LoopOptions, LoopResult } from "../goals.js";
import { runLoop } from "../loops.js";
import { MiningIteration } from "./mining-iteration.js";
import { checkHarvesterForPoi } from "./mining-precheck.js";

const log = createLogger("loop:enhanced-mining");

/** Options for the enhanced mining loop. */
export interface EnhancedMiningLoopOptions {
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
	/** Item IDs considered junk — will be jettisoned when cargo is full. */
	junkItemIds: string[];
	/** Cargo fullness threshold for MineWithJettison. */
	fullThreshold?: number;
	/** Max total mine attempts per run. */
	maxAttempts?: number;
	/** Max jettison-then-mine cycles per run. */
	maxJettisonRounds?: number;
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
 * Run an enhanced mining loop: mine with jettison until full → sell at station → repeat.
 *
 * Each iteration is a MiningIteration containing:
 * 1. Pre-flight round-trip fuel check (refuels at sell station if needed)
 * 2. EnhancedMiningRun — travel to belt, mine with jettison until cargo full
 * 3. SellAtStation — travel to station, dock, sell all cargo (includes refuel)
 *
 * Returns when stopped, cancelled, or failed.
 */
export async function runEnhancedMiningLoop(
	options: EnhancedMiningLoopOptions,
	ctx: GoalContext,
): Promise<LoopResult> {
	log.info(`Starting enhanced mining loop: belt=${options.beltPoiId} → sell=${options.sellBaseId}`);

	const precheckResult = await checkHarvesterForPoi(
		{
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

	const factory = () => {
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
		return new MiningIteration({
			iterationName: "enhanced-mining-iteration",
			miningPoiId: options.beltPoiId,
			runGoal: new EnhancedMiningRun({
				systemId: options.miningSystemId,
				beltPoiId: options.beltPoiId,
				junkItemIds: options.junkItemIds,
				...(options.fullThreshold !== undefined ? { fullThreshold: options.fullThreshold } : {}),
				...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
				...(options.maxJettisonRounds !== undefined
					? { maxJettisonRounds: options.maxJettisonRounds }
					: {}),
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

	return runLoop(factory, ctx, {
		...options.loopOptions,
		ignoreFailure,
		shouldContinue,
	});
}
