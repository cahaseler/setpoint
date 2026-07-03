import type { StorageResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:load-from-storage");

/** View result — the union member returned by action=view (has an `items` array). */
type StorageViewResult = Extract<StorageResponse, { items: unknown }>;

/**
 * Load an item from base storage into the ship's cargo hold.
 *
 * Withdraws as much as possible (up to maxQuantity) considering:
 * - Available quantity in storage
 * - Remaining cargo capacity
 *
 * Already satisfied if cargo already has >= maxQuantity of the item.
 * Prerequisites: must be docked at a station.
 * Costs 1 tick (single withdraw action).
 */
export class LibLoadFromStorage implements LibGoal {
	readonly name = "load-from-storage";
	private readonly itemId: string;
	private readonly maxQuantity: number | undefined;

	/**
	 * @param itemId The item to withdraw from storage
	 * @param maxQuantity Maximum quantity to load. If undefined, loads as much as fits.
	 */
	constructor(itemId: string, maxQuantity?: number) {
		this.itemId = itemId;
		this.maxQuantity = maxQuantity;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot load from storage: must be docked at a station", 0);
		}

		// Refresh state to get live cargo before checking — ctx.state may be stale
		const state = await ctx.refreshState();

		// Check current cargo for this item
		const currentInCargo = state.cargo?.find((c) => c.item_id === this.itemId)?.quantity ?? 0;

		if (this.maxQuantity !== undefined && currentInCargo >= this.maxQuantity) {
			return alreadySatisfied(
				`Already have ${currentInCargo} of ${this.itemId} in cargo (target: ${this.maxQuantity})`,
			);
		}

		// Check available cargo space
		const cargoCapacity = state.ship?.cargo_capacity;
		const cargoUsed = state.ship?.cargo_used;

		if (cargoCapacity === undefined || cargoUsed === undefined) {
			return failed("Cannot load from storage: ship cargo info unknown", 0);
		}

		const freeSpace = cargoCapacity - cargoUsed;
		if (freeSpace <= 0) {
			return alreadySatisfied("Cargo hold is full, nothing more to load from storage");
		}

		// Check storage for available quantity and item size
		const storageResponse = await ctx.account.commands.spacemolt_storage.view({ target: "self" });
		const storageItems =
			(storageResponse.structuredContent as StorageViewResult | undefined)?.items ?? [];
		const storageItem = storageItems.find((s) => s.item_id === this.itemId);
		const inStorage = storageItem?.quantity ?? 0;

		if (inStorage <= 0) {
			return alreadySatisfied(`No ${this.itemId} available in storage`);
		}

		const itemSize = storageItem?.size ?? 1;
		const maxBySpace = Math.floor(freeSpace / itemSize);

		// Calculate how much to withdraw
		let toWithdraw = inStorage;
		if (this.maxQuantity !== undefined) {
			toWithdraw = Math.min(toWithdraw, this.maxQuantity - currentInCargo);
		}
		toWithdraw = Math.min(toWithdraw, maxBySpace);

		if (toWithdraw <= 0) {
			return alreadySatisfied(`Cannot fit more ${this.itemId} in cargo`);
		}

		log.info(`Withdrawing ${toWithdraw}x ${this.itemId} from storage`);
		await ctx.account.commands.spacemolt_storage.withdraw({
			item_id: this.itemId,
			quantity: toWithdraw,
			target: "self",
		});

		return succeeded(`Loaded ${toWithdraw}x ${this.itemId} from storage`, 1);
	}
}
