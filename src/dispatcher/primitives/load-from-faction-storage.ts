import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:load-from-faction-storage");

/**
 * Load an item from faction storage into the ship's cargo hold.
 *
 * Withdraws as much as possible (up to maxQuantity) considering:
 * - Available quantity in faction storage
 * - Remaining cargo capacity
 *
 * Already satisfied if cargo already has >= maxQuantity of the item.
 * Prerequisites: must be docked at a station.
 * Costs 1 tick (single withdraw action).
 */
export class LoadFromFactionStorage implements Goal {
	readonly name = "load-from-faction-storage";
	private readonly itemId: string;
	private readonly maxQuantity: number | undefined;

	constructor(itemId: string, maxQuantity?: number) {
		this.itemId = itemId;
		this.maxQuantity = maxQuantity;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot load from faction storage: must be docked at a station", 0);
		}

		// Query live cargo and ship state to avoid stale data.
		const cargoResponse = await ctx.endpoints.getCargo();
		const liveCargo = cargoResponse.structuredContent.cargo;
		const liveShip = cargoResponse.structuredContent.ship;

		const currentInCargo = liveCargo?.find((c) => c.item_id === this.itemId)?.quantity ?? 0;

		if (this.maxQuantity !== undefined && currentInCargo >= this.maxQuantity) {
			return alreadySatisfied(
				`Already have ${currentInCargo} of ${this.itemId} in cargo (target: ${this.maxQuantity})`,
			);
		}

		const cargoCapacity = liveShip?.cargo_capacity ?? ctx.state.ship?.cargo_capacity;
		// Compute cargo used from live items — liveShip.cargo_used may be null or stale
		// (get_cargo often returns ship: null, and mutations may not update cargo_used promptly)
		const cargoUsed = (liveCargo ?? []).reduce(
			(sum, item) => sum + (item.quantity ?? 0) * (item.size ?? 1),
			0,
		);

		if (cargoCapacity === undefined) {
			return failed("Cannot load from faction storage: ship cargo info unknown", 0);
		}

		const freeSpace = cargoCapacity - cargoUsed;
		if (freeSpace <= 0) {
			return alreadySatisfied("Cargo hold is full, nothing more to load from faction storage");
		}

		// Check faction storage for available quantity and item size
		const storageResponse = await ctx.endpoints.viewFactionStorage();
		const storageItems = storageResponse.structuredContent.items ?? [];
		const storageItem = storageItems.find((s) => s.item_id === this.itemId);
		const inStorage = storageItem?.quantity ?? 0;

		if (inStorage <= 0) {
			return alreadySatisfied(`No ${this.itemId} available in faction storage`);
		}

		const itemSize = storageItem?.size ?? 1;
		const maxBySpace = Math.floor(freeSpace / itemSize);

		let toWithdraw = inStorage;
		if (this.maxQuantity !== undefined) {
			toWithdraw = Math.min(toWithdraw, this.maxQuantity - currentInCargo);
		}
		toWithdraw = Math.min(toWithdraw, maxBySpace);

		if (toWithdraw <= 0) {
			return alreadySatisfied(`Cannot fit more ${this.itemId} in cargo`);
		}

		log.info(`Withdrawing ${toWithdraw}x ${this.itemId} from faction storage`);
		await ctx.endpoints.withdrawFromFactionStorage(this.itemId, toWithdraw);

		return succeeded(`Loaded ${toWithdraw}x ${this.itemId} from faction storage`, 1);
	}
}
