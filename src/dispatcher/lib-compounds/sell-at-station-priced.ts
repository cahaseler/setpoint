import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import {
	LibListCargoForSale,
	type ListCargoForSaleOptions,
} from "../lib-primitives/list-cargo-for-sale.js";
import { runLibSequence } from "../lib-sequence.js";
import { LibPrepareAtStation } from "./prepare-at-station.js";

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
	/** Fuel units the navigation step must keep in reserve. Defaults to 0. */
	fuelReserve?: number;
}

/**
 * Travel to a station, dock, and list cargo for sale at minimum prices.
 *
 * Steps:
 * 1. PrepareAtStation — navigate, dock, optionally refuel, optionally repair
 * 2. ListCargoForSale — create sell orders for matching cargo items at min prices
 */
export class LibSellAtStationPriced implements LibGoal {
	readonly name = "sell-at-station-priced";
	private readonly options: SellAtStationPricedOptions;

	constructor(options: SellAtStationPricedOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<CompoundGoalResult> {
		log.info(
			`Sell at station (priced): system=${this.options.systemId}, base=${this.options.baseId}, items=${this.options.items.length}`,
		);

		const steps: LibGoal[] = [
			new LibPrepareAtStation({
				systemId: this.options.systemId,
				poiId: this.options.stationPoiId,
				baseId: this.options.baseId,
				...(this.options.refuel !== undefined ? { refuel: this.options.refuel } : {}),
				...(this.options.fuelReserve !== undefined
					? { fuelReserve: this.options.fuelReserve }
					: {}),
			}),
			new LibListCargoForSale({ items: this.options.items }),
		];

		return runLibSequence(steps, ctx);
	}
}
