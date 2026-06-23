import { createLogger } from "../../util/logger.js";
import { BuyAtStation } from "../compounds/buy-at-station.js";
import { SellAtStationPriced } from "../compounds/sell-at-station-priced.js";
import type { GoalContext, LoopOptions, LoopResult } from "../goals.js";
import { runLoop } from "../loops.js";
import { SequenceGoal } from "../sequence-goal.js";

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
 * Run a trading loop: buy items at one station, sell at another, repeat.
 *
 * Each iteration is a SequenceGoal containing:
 * 1. BuyAtStation — travel to buy station, dock, buy items under max prices
 * 2. SellAtStationPriced — travel to sell station, dock, list cargo at min prices
 *
 * Returns when stopped, cancelled, or failed.
 */
export function runTradingLoop(options: TradingLoopOptions, ctx: GoalContext): Promise<LoopResult> {
	log.info(
		`Starting trading loop: buy@${options.buyStation.baseId} → sell@${options.sellStation.baseId}, ${options.items.length} item(s)`,
	);

	const factory = () =>
		new SequenceGoal("trading-iteration", [
			new BuyAtStation({
				systemId: options.buyStation.systemId,
				poiId: options.buyStation.poiId,
				baseId: options.buyStation.baseId,
				items: options.items.map((item) => ({
					itemId: item.itemId,
					maxPrice: item.maxBuyPrice,
					...(item.maxQuantity !== undefined ? { maxQuantity: item.maxQuantity } : {}),
				})),
				...(options.refuel !== undefined ? { refuel: options.refuel } : {}),
			}),
			new SellAtStationPriced({
				systemId: options.sellStation.systemId,
				stationPoiId: options.sellStation.stationPoiId,
				baseId: options.sellStation.baseId,
				items: options.items.map((item) => ({
					itemId: item.itemId,
					minPrice: item.minSellPrice,
				})),
				...(options.refuel !== undefined ? { refuel: options.refuel } : {}),
			}),
		]);

	return runLoop(factory, ctx, options.loopOptions);
}
