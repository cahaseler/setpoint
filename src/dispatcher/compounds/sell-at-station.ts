import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult, Goal, GoalContext } from "../goals.js";
import { SellOrDepositCargo } from "../primitives/index.js";
import { runSequence } from "../sequence.js";
import { PrepareAtStation } from "./prepare-at-station.js";

const log = createLogger("goal:sell-at-station");

/** Options for the SellAtStation compound goal. */
export interface SellAtStationOptions {
	/** Target system for the station. */
	systemId: string;
	/** POI ID of the station. */
	stationPoiId: string;
	/** Base ID to dock at. */
	baseId: string;
	/** Whether to refuel after docking. Defaults to true. */
	refuel?: boolean;
	/** Whether to repair hull after docking. Defaults to false. */
	repair?: boolean;
	/** Where to deposit items with no market buyers. Defaults to "personal". */
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
}

/**
 * Travel to a station, dock, and sell/deposit all cargo.
 *
 * Steps:
 * 1. PrepareAtStation — navigate, dock, optionally refuel, optionally repair
 * 2. SellOrDepositCargo — sell items with market buyers, deposit rest to storage
 */
export class SellAtStation implements Goal {
	readonly name = "sell-at-station";
	private readonly options: SellAtStationOptions;

	constructor(options: SellAtStationOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<CompoundGoalResult> {
		log.info(
			`Sell at station: system=${this.options.systemId}, poi=${this.options.stationPoiId}, base=${this.options.baseId}`,
		);

		const steps: Goal[] = [
			new PrepareAtStation({
				systemId: this.options.systemId,
				poiId: this.options.stationPoiId,
				baseId: this.options.baseId,
				...(this.options.refuel !== undefined ? { refuel: this.options.refuel } : {}),
				repair: this.options.repair ?? true,
				...(this.options.cashSource !== undefined ? { cashSource: this.options.cashSource } : {}),
				...(this.options.minCredits !== undefined ? { minCredits: this.options.minCredits } : {}),
			}),
			new SellOrDepositCargo({
				...(this.options.depositTarget !== undefined
					? { depositTarget: this.options.depositTarget }
					: {}),
				...(this.options.skipMarket !== undefined ? { skipMarket: this.options.skipMarket } : {}),
				...(this.options.listPrice !== undefined ? { listPrice: this.options.listPrice } : {}),
				...(this.options.listPrices !== undefined ? { listPrices: this.options.listPrices } : {}),
			}),
		];

		return runSequence(steps, ctx);
	}
}
