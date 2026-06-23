import { createLogger } from "../../util/logger.js";
import { LoadAtStation, type LoadSourceType } from "../compounds/load-at-station.js";
import { UnloadAtStation, type UnloadDestType } from "../compounds/unload-at-station.js";
import type { GoalContext, LoopOptions, LoopResult } from "../goals.js";
import { runLoop } from "../loops.js";
import { SequenceGoal } from "../sequence-goal.js";

const log = createLogger("loop:hauling");

/** Options for the HaulingLoop. */
export interface HaulingLoopOptions {
	/** Source station and loading configuration. */
	source: {
		systemId: string;
		poiId: string;
		baseId: string;
		type: LoadSourceType;
		items: Array<{
			itemId: string;
			quantity?: number;
			maxPrice?: number;
		}>;
	};
	/** Destination station and unloading configuration. */
	destination: {
		systemId: string;
		poiId: string;
		baseId: string;
		type: UnloadDestType;
		targetPlayer?: string;
		items?: Array<{
			itemId: string;
			minPrice?: number;
		}>;
	};
	/** Whether to refuel at each station. Defaults to true. */
	refuel?: boolean;
	/**
	 * Extra fuel units to keep in reserve beyond the route's estimated fuel cost.
	 * The NavigateToSystem pre-flight check (estimated_fuel <= fuel_available) provides
	 * the primary one-way fuel guard; this reserve adds margin for in-system travel.
	 * Defaults to 0. Currently informational — a future change may wire this into the
	 * pre-flight check once the NavigateToSystem API supports a reserve parameter.
	 */
	minFuelReserve?: number;
	/** Loop control options (signal, maxIterations, shouldContinue). */
	loopOptions?: LoopOptions;
}

/**
 * Run a hauling loop: load items at source station, unload at destination, repeat.
 *
 * Each iteration is a SequenceGoal containing:
 * 1. LoadAtStation — travel to source, dock, load from configured source type
 * 2. UnloadAtStation — travel to dest, dock, unload to configured dest type
 *
 * Returns when stopped, cancelled, or failed.
 */
export function runHaulingLoop(options: HaulingLoopOptions, ctx: GoalContext): Promise<LoopResult> {
	log.info(
		`Starting hauling loop: ${options.source.type}@${options.source.baseId} → ${options.destination.type}@${options.destination.baseId}`,
	);

	const factory = () =>
		new SequenceGoal("hauling-iteration", [
			new LoadAtStation({
				systemId: options.source.systemId,
				poiId: options.source.poiId,
				baseId: options.source.baseId,
				sourceType: options.source.type,
				items: options.source.items,
				...(options.refuel !== undefined ? { refuel: options.refuel } : {}),
			}),
			new UnloadAtStation({
				systemId: options.destination.systemId,
				poiId: options.destination.poiId,
				baseId: options.destination.baseId,
				destType: options.destination.type,
				...(options.destination.targetPlayer !== undefined
					? { targetPlayer: options.destination.targetPlayer }
					: {}),
				...(options.destination.items !== undefined ? { items: options.destination.items } : {}),
				...(options.refuel !== undefined ? { refuel: options.refuel } : {}),
			}),
		]);

	return runLoop(factory, ctx, options.loopOptions);
}
