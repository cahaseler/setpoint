import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { LibBuyItems } from "../lib-primitives/buy-items.js";
import { LibLoadFromFactionStorage } from "../lib-primitives/load-from-faction-storage.js";
import { LibLoadFromStorage } from "../lib-primitives/load-from-storage.js";
import { runLibSequence } from "../lib-sequence.js";
import { LibPrepareAtStation } from "./prepare-at-station.js";

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
	/** Fuel units the navigation step must keep in reserve. Defaults to 0. */
	fuelReserve?: number;
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
export class LibLoadAtStation implements LibGoal {
	readonly name = "load-at-station";
	private readonly options: LoadAtStationOptions;

	constructor(options: LoadAtStationOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<CompoundGoalResult> {
		log.info(
			`Load at station: system=${this.options.systemId}, source=${this.options.sourceType}, items=${this.options.items.length}`,
		);

		const steps: LibGoal[] = [
			new LibPrepareAtStation({
				systemId: this.options.systemId,
				poiId: this.options.poiId,
				baseId: this.options.baseId,
				...(this.options.refuel !== undefined ? { refuel: this.options.refuel } : {}),
				...(this.options.fuelReserve !== undefined
					? { fuelReserve: this.options.fuelReserve }
					: {}),
			}),
			...this.buildLoadSteps(),
		];

		return runLibSequence(steps, ctx);
	}

	private buildLoadSteps(): LibGoal[] {
		switch (this.options.sourceType) {
			case "personal-storage":
				return this.options.items.map((item) => new LibLoadFromStorage(item.itemId, item.quantity));
			case "faction-storage":
				return this.options.items.map(
					(item) => new LibLoadFromFactionStorage(item.itemId, item.quantity),
				);
			case "market":
				return [
					new LibBuyItems({
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
