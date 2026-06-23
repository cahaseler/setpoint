import type { StoredGameState } from "../../state/store.js";
import { createLogger } from "../../util/logger.js";
import { PrepareAtStation } from "../compounds/prepare-at-station.js";
import { TransferStorageToFaction } from "../compounds/transfer-storage-to-faction.js";
import type { GoalContext, GoalResult, LoopOptions, LoopResult } from "../goals.js";
import { runLoop } from "../loops.js";
import { SequenceGoal } from "../sequence-goal.js";

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
 * Each iteration is a SequenceGoal containing:
 * 1. PrepareAtStation — navigate, dock, optionally refuel, optionally repair
 * 2. TransferStorageToFaction — view personal storage, deposit all items/credits to faction
 *
 * Uses cashSource="faction" so the ship can withdraw credits from faction
 * storage to fund refueling, rather than failing when the player is broke.
 *
 * The loop terminates when TransferStorageToFaction returns alreadySatisfied
 * (personal storage is empty or all at cap), or when stopped/cancelled.
 */
export function runStorageTransferLoop(
	options: StorageTransferLoopOptions,
	ctx: GoalContext,
): Promise<LoopResult> {
	log.info(`Starting storage transfer loop: station=${options.baseId}`);

	const factory = () =>
		new SequenceGoal("storage-transfer-iteration", [
			new PrepareAtStation({
				systemId: options.systemId,
				poiId: options.stationPoiId,
				baseId: options.baseId,
				...(options.refuel !== undefined ? { refuel: options.refuel } : {}),
				cashSource: "faction",
			}),
			new TransferStorageToFaction({
				...(options.excludeCredits !== undefined ? { excludeCredits: options.excludeCredits } : {}),
			}),
		]);

	// Track the last iteration result to detect when storage is empty.
	// shouldContinue runs before each iteration with the current state,
	// so we use onIterationComplete to capture the result and check it
	// on the next shouldContinue call.
	let lastResult: GoalResult | undefined;

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

	return runLoop(factory, ctx, {
		...options.loopOptions,
		shouldContinue: options.loopOptions?.shouldContinue ?? shouldContinue,
		onIterationComplete,
	});
}
