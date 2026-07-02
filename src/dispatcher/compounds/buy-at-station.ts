import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult, Goal, GoalContext } from "../goals.js";
import { BuyItems, type BuyItemsOptions } from "../primitives/index.js";
import { runSequence } from "../sequence.js";
import { PrepareAtStation } from "./prepare-at-station.js";

const log = createLogger("goal:buy-at-station");

/** Options for the BuyAtStation compound goal. */
export interface BuyAtStationOptions {
	/** Target system for the station. */
	systemId: string;
	/** POI ID of the station. */
	poiId: string;
	/** Base ID to dock at. */
	baseId: string;
	/** Items to buy with price limits. */
	items: BuyItemsOptions["items"];
	/** Whether to refuel after docking. Defaults to true. */
	refuel?: boolean;
	/** Fuel units the navigation step must keep in reserve. Defaults to 0. */
	fuelReserve?: number;
}

/**
 * Travel to a station, dock, and buy items from the market at price limits.
 *
 * Steps:
 * 1. PrepareAtStation — navigate, dock, optionally refuel, optionally repair
 * 2. BuyItems — scan market, buy items under max price
 */
export class BuyAtStation implements Goal {
	readonly name = "buy-at-station";
	private readonly options: BuyAtStationOptions;

	constructor(options: BuyAtStationOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<CompoundGoalResult> {
		log.info(
			`Buy at station: system=${this.options.systemId}, base=${this.options.baseId}, items=${this.options.items.length}`,
		);

		const steps: Goal[] = [
			new PrepareAtStation({
				systemId: this.options.systemId,
				poiId: this.options.poiId,
				baseId: this.options.baseId,
				...(this.options.refuel !== undefined ? { refuel: this.options.refuel } : {}),
				...(this.options.fuelReserve !== undefined
					? { fuelReserve: this.options.fuelReserve }
					: {}),
			}),
			new BuyItems({ items: this.options.items }),
		];

		return runSequence(steps, ctx);
	}
}
