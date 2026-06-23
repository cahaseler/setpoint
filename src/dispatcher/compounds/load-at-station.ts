import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult, Goal, GoalContext } from "../goals.js";
import { BuyItems, LoadFromFactionStorage, LoadFromStorage } from "../primitives/index.js";
import { runSequence } from "../sequence.js";
import { PrepareAtStation } from "./prepare-at-station.js";

const log = createLogger("goal:load-at-station");

/** Source type for loading items. */
export type LoadSourceType = "personal-storage" | "faction-storage" | "market";

/** Options for the LoadAtStation compound goal. */
export interface LoadAtStationOptions {
	/** Target system for the station. */
	systemId: string;
	/** POI ID of the station. */
	poiId: string;
	/** Base ID to dock at. */
	baseId: string;
	/** Where to load items from. */
	sourceType: LoadSourceType;
	/** Items to load. quantity used for storage, maxPrice for market. */
	items: Array<{
		itemId: string;
		quantity?: number;
		maxPrice?: number;
	}>;
	/** Whether to refuel after docking. Defaults to true. */
	refuel?: boolean;
}

/**
 * Travel to a station, dock, and load items from a configured source.
 *
 * Steps:
 * 1. PrepareAtStation — navigate, dock, optionally refuel, optionally repair
 * 2. Load items based on sourceType:
 *    - personal-storage: LoadFromStorage for each item
 *    - faction-storage: LoadFromFactionStorage for each item
 *    - market: BuyItems with price limits
 */
export class LoadAtStation implements Goal {
	readonly name = "load-at-station";
	private readonly options: LoadAtStationOptions;

	constructor(options: LoadAtStationOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<CompoundGoalResult> {
		log.info(
			`Load at station: system=${this.options.systemId}, source=${this.options.sourceType}, items=${this.options.items.length}`,
		);

		const steps: Goal[] = [
			new PrepareAtStation({
				systemId: this.options.systemId,
				poiId: this.options.poiId,
				baseId: this.options.baseId,
				...(this.options.refuel !== undefined ? { refuel: this.options.refuel } : {}),
			}),
			...this.buildLoadSteps(),
		];

		return runSequence(steps, ctx);
	}

	private buildLoadSteps(): Goal[] {
		switch (this.options.sourceType) {
			case "personal-storage":
				return this.options.items.map((item) => new LoadFromStorage(item.itemId, item.quantity));
			case "faction-storage":
				return this.options.items.map(
					(item) => new LoadFromFactionStorage(item.itemId, item.quantity),
				);
			case "market":
				return [
					new BuyItems({
						items: this.options.items.map((item) => ({
							itemId: item.itemId,
							maxPrice: item.maxPrice ?? Number.MAX_SAFE_INTEGER,
							...(item.quantity !== undefined ? { maxQuantity: item.quantity } : {}),
						})),
					}),
				];
		}
	}
}
