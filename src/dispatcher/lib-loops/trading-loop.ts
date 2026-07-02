import { createLogger } from "../../util/logger.js";
import type { LoopOptions, LoopResult } from "../goals.js";
import { LibBuyAtStation } from "../lib-compounds/buy-at-station.js";
import { LibSellAtStationPriced } from "../lib-compounds/sell-at-station-priced.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { type LibGoalFactory, runLibLoop } from "../lib-loops.js";
import { runLibSequence } from "../lib-sequence.js";

const log = createLogger("loop:trading");

/** Options for the TradingLoop. */
export interface TradingLoopOptions {
	/** Station to buy items at. */
	buyStation: {
		systemId: string;
		poiId: string;
		baseId: string;
	};
	/** Station to sell items at. */
	sellStation: {
		systemId: string;
		stationPoiId: string;
		baseId: string;
	};
	/** Items to trade with buy/sell price limits. */
	items: Array<{
		itemId: string;
		maxBuyPrice: number;
		minSellPrice: number;
		maxQuantity?: number;
	}>;
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
 * Run a trading loop: buy items at one station, sell at another, repeat.
 *
 * Each iteration is a sequence goal containing:
 * 1. LibBuyAtStation — travel to buy station, dock, buy items under max prices
 * 2. LibSellAtStationPriced — travel to sell station, dock, list cargo at min prices
 *
 * Returns when stopped, cancelled, or failed.
 */
export function runTradingLoop(
	options: TradingLoopOptions,
	ctx: LibGoalContext,
): Promise<LoopResult> {
	log.info(
		`Starting trading loop: buy@${options.buyStation.baseId} → sell@${options.sellStation.baseId}, ${options.items.length} item(s)`,
	);

	const factory: LibGoalFactory = (): LibGoal => ({
		name: "trading-iteration",
		execute: (stepCtx) =>
			runLibSequence(
				[
					new LibBuyAtStation({
						systemId: options.buyStation.systemId,
						poiId: options.buyStation.poiId,
						baseId: options.buyStation.baseId,
						items: options.items.map((item) => ({
							itemId: item.itemId,
							maxPrice: item.maxBuyPrice,
							...(item.maxQuantity !== undefined ? { maxQuantity: item.maxQuantity } : {}),
						})),
						...(options.refuel !== undefined ? { refuel: options.refuel } : {}),
						...(options.minFuelReserve !== undefined
							? { fuelReserve: options.minFuelReserve }
							: {}),
					}),
					new LibSellAtStationPriced({
						systemId: options.sellStation.systemId,
						stationPoiId: options.sellStation.stationPoiId,
						baseId: options.sellStation.baseId,
						items: options.items.map((item) => ({
							itemId: item.itemId,
							minPrice: item.minSellPrice,
						})),
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
