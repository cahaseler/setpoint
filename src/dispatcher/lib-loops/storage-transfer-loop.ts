import type { StoredGameState } from "../../state/store.js";
import { createLogger } from "../../util/logger.js";
import type { GoalResult, LoopOptions, LoopResult } from "../goals.js";
import { LibPrepareAtStation } from "../lib-compounds/prepare-at-station.js";
import { LibTransferStorageToFaction } from "../lib-compounds/transfer-storage-to-faction.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { type LibGoalFactory, runLibLoop } from "../lib-loops.js";
import { runLibSequence } from "../lib-sequence.js";

const log = createLogger("loop:storage-transfer");

/** Options for the storage transfer loop. */
export interface StorageTransferLoopOptions {
	/** System containing the station with storage access. */
	systemId: string;
	/** POI ID of the station. */
	stationPoiId: string;
	/** Base ID to dock at. */
	baseId: string;
	/** Whether to refuel after docking. Defaults to true. */
	refuel?: boolean;
	/** Skip transferring credits to faction storage. Default: false. */
	excludeCredits?: boolean;
	/** Loop control options (signal, maxIterations, shouldContinue). */
	loopOptions?: LoopOptions;
}

/**
 * Run a storage transfer loop: dock at station → transfer personal storage to faction → repeat.
 *
 * Each iteration is a sequence goal containing:
 * 1. LibPrepareAtStation — navigate, dock, optionally refuel, optionally repair
 * 2. LibTransferStorageToFaction — view personal storage, deposit all items/credits to faction
 *
 * Uses cashSource="faction" so the ship can withdraw credits from faction
 * storage to fund refueling, rather than failing when the player is broke.
 *
 * The loop terminates when LibTransferStorageToFaction returns alreadySatisfied
 * (personal storage is empty or all at cap), or when stopped/cancelled.
 */
export function runStorageTransferLoop(
	options: StorageTransferLoopOptions,
	ctx: LibGoalContext,
): Promise<LoopResult> {
	log.info(`Starting storage transfer loop: station=${options.baseId}`);

	const factory: LibGoalFactory = (): LibGoal => ({
		name: "storage-transfer-iteration",
		execute: (stepCtx) =>
			runLibSequence(
				[
					new LibPrepareAtStation({
						systemId: options.systemId,
						poiId: options.stationPoiId,
						baseId: options.baseId,
						...(options.refuel !== undefined ? { refuel: options.refuel } : {}),
						cashSource: "faction",
					}),
					new LibTransferStorageToFaction({
						...(options.excludeCredits !== undefined
							? { excludeCredits: options.excludeCredits }
							: {}),
					}),
				],
				stepCtx,
			),
	});

	// Track the last iteration result to detect when storage is empty.
	// shouldContinue runs before each iteration with the current state,
	// so we use onIterationComplete to capture the result and check it
	// on the next shouldContinue call.
	let lastResult: GoalResult | undefined;

	// shouldContinue is typed against StoredGameState in the shared LoopOptions
	// (see runLibLoop's cast comment) — this loop doesn't read state fields, so
	// the type only matters for satisfying the shared signature.
	const shouldContinue = (_iteration: number, _state: StoredGameState): boolean => {
		if (lastResult?.alreadySatisfied) {
			return false;
		}
		return true;
	};

	const onIterationComplete = (iteration: number, result: GoalResult): void => {
		lastResult = result;
		options.loopOptions?.onIterationComplete?.(iteration, result);
	};

	return runLibLoop(factory, ctx, {
		...options.loopOptions,
		shouldContinue: options.loopOptions?.shouldContinue ?? shouldContinue,
		onIterationComplete,
	});
}
