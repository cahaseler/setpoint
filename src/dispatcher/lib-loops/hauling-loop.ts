import { createLogger } from "../../util/logger.js";
import type { LoopOptions, LoopResult } from "../goals.js";
import { LibLoadAtStation, type LoadSourceType } from "../lib-compounds/load-at-station.js";
import { LibUnloadAtStation, type UnloadDestType } from "../lib-compounds/unload-at-station.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { type LibGoalFactory, runLibLoop } from "../lib-loops.js";
import { runLibSequence } from "../lib-sequence.js";

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
	 * Fed into the NavigateToSystem pre-flight check (estimated_fuel + reserve <=
	 * fuel_available), so each leg fails before departing unless the ship would
	 * arrive with at least this much fuel to spare for in-system travel.
	 * Defaults to 0.
	 */
	minFuelReserve?: number;
	/** Loop control options (signal, maxIterations, shouldContinue). */
	loopOptions?: LoopOptions;
}

/**
 * Run a hauling loop: load items at source station, unload at destination, repeat.
 *
 * Each iteration is a sequence goal containing:
 * 1. LibLoadAtStation — travel to source, dock, load from configured source type
 * 2. LibUnloadAtStation — travel to dest, dock, unload to configured dest type
 *
 * Returns when stopped, cancelled, or failed.
 */
export function runHaulingLoop(
	options: HaulingLoopOptions,
	ctx: LibGoalContext,
): Promise<LoopResult> {
	log.info(
		`Starting hauling loop: ${options.source.type}@${options.source.baseId} → ${options.destination.type}@${options.destination.baseId}`,
	);

	const factory: LibGoalFactory = (): LibGoal => ({
		name: "hauling-iteration",
		execute: (stepCtx) =>
			runLibSequence(
				[
					new LibLoadAtStation({
						systemId: options.source.systemId,
						poiId: options.source.poiId,
						baseId: options.source.baseId,
						sourceType: options.source.type,
						items: options.source.items,
						...(options.refuel !== undefined ? { refuel: options.refuel } : {}),
						...(options.minFuelReserve !== undefined
							? { fuelReserve: options.minFuelReserve }
							: {}),
					}),
					new LibUnloadAtStation({
						systemId: options.destination.systemId,
						poiId: options.destination.poiId,
						baseId: options.destination.baseId,
						destType: options.destination.type,
						...(options.destination.targetPlayer !== undefined
							? { targetPlayer: options.destination.targetPlayer }
							: {}),
						...(options.destination.items !== undefined
							? { items: options.destination.items }
							: {}),
						...(options.refuel !== undefined ? { refuel: options.refuel } : {}),
						...(options.minFuelReserve !== undefined
							? { fuelReserve: options.minFuelReserve }
							: {}),
					}),
				],
				stepCtx,
			),
	});

	return runLibLoop(factory, ctx, options.loopOptions);
}
