import { createLogger } from "../../util/logger.js";
import { actionableStacks } from "../cargo.js";
import type { CompoundGoalResult, Goal, GoalContext } from "../goals.js";
import { GiftToPlayer, ListCargoForSale, SellOrDepositCargo } from "../primitives/index.js";
import { runSequence } from "../sequence.js";
import { PrepareAtStation } from "./prepare-at-station.js";

const log = createLogger("goal:unload-at-station");

/** Valid destination types for unloading items. */
export const UNLOAD_DEST_TYPES = ["personal-storage", "faction-storage", "gift", "market"] as const;

/** Destination type for unloading items. */
export type UnloadDestType = (typeof UNLOAD_DEST_TYPES)[number];

/** Options for the UnloadAtStation compound goal. */
export interface UnloadAtStationOptions {
	/** Target system for the station. */
	systemId: string;
	/** POI ID of the station. */
	poiId: string;
	/** Base ID to dock at. */
	baseId: string;
	/** Where to unload items to. */
	destType: UnloadDestType;
	/** Target player name. Required when destType is "gift". */
	targetPlayer?: string;
	/** Item-specific sell prices for "market" destType. */
	items?: Array<{
		itemId: string;
		minPrice?: number;
	}>;
	/** Whether to refuel after docking. Defaults to true. */
	refuel?: boolean;
	/** Fuel units the navigation step must keep in reserve. Defaults to 0. */
	fuelReserve?: number;
}

/**
 * Travel to a station, dock, and unload items to a configured destination.
 *
 * Steps:
 * 1. PrepareAtStation — navigate, dock, optionally refuel, optionally repair
 * 2. Unload based on destType:
 *    - personal-storage: SellOrDepositCargo (deposits items without buyers)
 *    - faction-storage: SellOrDepositCargo with skipMarket=true (reads live cargo)
 *    - gift: GiftToPlayer for each cargo item
 *    - market: ListCargoForSale with min prices
 */
export class UnloadAtStation implements Goal {
	readonly name = "unload-at-station";
	private readonly options: UnloadAtStationOptions;

	constructor(options: UnloadAtStationOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<CompoundGoalResult> {
		log.info(`Unload at station: system=${this.options.systemId}, dest=${this.options.destType}`);

		// Defend against destType values the registry cast let through —
		// an unrecognized value must fail the goal, not crash the job.
		if (!UNLOAD_DEST_TYPES.includes(this.options.destType)) {
			return {
				success: false,
				message: `Unknown destType "${this.options.destType}" — valid: ${UNLOAD_DEST_TYPES.join(", ")}`,
				alreadySatisfied: false,
				ticksUsed: 0,
				steps: [],
			};
		}

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
			...this.buildUnloadSteps(ctx),
		];

		return runSequence(steps, ctx);
	}

	private buildUnloadSteps(ctx: GoalContext): Goal[] {
		switch (this.options.destType) {
			case "personal-storage":
				return [new SellOrDepositCargo()];

			case "faction-storage":
				// Read live cargo at execution time (not from state snapshot) to avoid
				// depositing items that weren't actually loaded in the current cycle.
				return [new SellOrDepositCargo({ depositTarget: "faction", skipMarket: true })];

			case "gift": {
				const targetPlayer = this.options.targetPlayer;
				if (!targetPlayer) {
					return [];
				}
				return actionableStacks(ctx.state.cargo).map(
					(item) =>
						new GiftToPlayer({
							targetName: targetPlayer,
							itemId: item.item_id,
							quantity: item.quantity,
						}),
				);
			}

			case "market": {
				const itemPrices = this.options.items ?? [];
				if (itemPrices.length === 0) {
					// No price config — sell at whatever price via SellOrDepositCargo
					return [new SellOrDepositCargo()];
				}
				return [
					new ListCargoForSale({
						items: itemPrices
							.filter(
								(item): item is { itemId: string; minPrice: number } => item.minPrice !== undefined,
							)
							.map((item) => ({
								itemId: item.itemId,
								minPrice: item.minPrice,
							})),
					}),
				];
			}
		}
	}
}
