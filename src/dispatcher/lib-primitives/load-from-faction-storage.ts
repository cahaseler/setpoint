import type { StorageResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:load-from-faction-storage");

/** View result — the union member returned by action=view (has an `items` array). */
type StorageViewResult = Extract<StorageResponse, { items: unknown }>;

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
export class LibLoadFromFactionStorage implements LibGoal {
	readonly name = "load-from-faction-storage";
	private readonly itemId: string;
	private readonly maxQuantity: number | undefined;

	constructor(itemId: string, maxQuantity?: number) {
		this.itemId = itemId;
		this.maxQuantity = maxQuantity;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot load from faction storage: must be docked at a station", 0);
		}

		// Cargo and ship info are part of the push-fed cache — no live query needed.
		const cargo = ctx.state.cargo;
		const ship = ctx.state.ship;

		const currentInCargo = cargo?.find((c) => c.item_id === this.itemId)?.quantity ?? 0;

		if (this.maxQuantity !== undefined && currentInCargo >= this.maxQuantity) {
			return alreadySatisfied(
				`Already have ${currentInCargo} of ${this.itemId} in cargo (target: ${this.maxQuantity})`,
			);
		}

		const cargoCapacity = ship?.cargo_capacity;
		// Compute cargo used from cached cargo items — ship.cargo_used may lag a tick
		// behind the cargo delta on some responses.
		const cargoUsed = (cargo ?? []).reduce(
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
		const storageResponse = await ctx.account.commands.spacemolt_storage.view({
			target: "faction",
		});
		const storageItems =
			(storageResponse.structuredContent as StorageViewResult | undefined)?.items ?? [];
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
		await ctx.account.commands.spacemolt_storage.withdraw({
			item_id: this.itemId,
			quantity: toWithdraw,
			target: "faction",
		});

		return succeeded(`Loaded ${toWithdraw}x ${this.itemId} from faction storage`, 1);
	}
}
