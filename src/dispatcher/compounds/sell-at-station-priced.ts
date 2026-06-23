import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult, Goal, GoalContext } from "../goals.js";
import { ListCargoForSale, type ListCargoForSaleOptions } from "../primitives/index.js";
import { runSequence } from "../sequence.js";
import { PrepareAtStation } from "./prepare-at-station.js";

const log = createLogger("goal:sell-at-station-priced");

/** Options for the SellAtStationPriced compound goal. */
export interface SellAtStationPricedOptions {
	/** Target system for the station. */
	systemId: string;
	/** POI ID of the station. */
	stationPoiId: string;
	/** Base ID to dock at. */
	baseId: string;
	/** Items to sell with minimum prices. */
	items: ListCargoForSaleOptions["items"];
	/** Whether to refuel after docking. Defaults to true. */
	refuel?: boolean;
}

/**
 * Travel to a station, dock, and list cargo for sale at minimum prices.
 *
 * Steps:
 * 1. PrepareAtStation — navigate, dock, optionally refuel, optionally repair
 * 2. ListCargoForSale — create sell orders for matching cargo items at min prices
 */
export class SellAtStationPriced implements Goal {
	readonly name = "sell-at-station-priced";
	private readonly options: SellAtStationPricedOptions;

	constructor(options: SellAtStationPricedOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<CompoundGoalResult> {
		log.info(
			`Sell at station (priced): system=${this.options.systemId}, base=${this.options.baseId}, items=${this.options.items.length}`,
		);

		const steps: Goal[] = [
			new PrepareAtStation({
				systemId: this.options.systemId,
				poiId: this.options.stationPoiId,
				baseId: this.options.baseId,
				...(this.options.refuel !== undefined ? { refuel: this.options.refuel } : {}),
			}),
			new ListCargoForSale({ items: this.options.items }),
		];

		return runSequence(steps, ctx);
	}
}
