import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";

const log = createLogger("goal:withdraw-from-faction-storage");

export interface WithdrawFromFactionStorageOptions {
	itemId: string;
	quantity?: number;
}

/**
 * Withdraw an item or credits from faction storage into personal station storage.
 *
 * Uses deposit with source: "faction" (faction→personal storage) rather than
 * the withdraw endpoint, so items land in station storage instead of cargo.
 * This makes them available for create_sell_order and other station storage
 * operations without occupying cargo space.
 *
 * If quantity is not specified, withdraws all available quantity.
 *
 * Prerequisites: must be docked at a station.
 * Costs 1 tick.
 */
export class WithdrawFromFactionStorage implements Goal {
	readonly name = "withdraw-from-faction-storage";
	private readonly options: WithdrawFromFactionStorageOptions;

	constructor(options: WithdrawFromFactionStorageOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot withdraw from faction storage: must be docked at a station", 0);
		}

		const isCredits = this.options.itemId === "credits";

		// Check faction storage for available quantity
		const storageResponse = await ctx.endpoints.viewFactionStorage();
		const storageItems = storageResponse.structuredContent.items ?? [];
		const inStorage = isCredits
			? (storageResponse.structuredContent.credits ?? 0)
			: (storageItems.find((s) => s.item_id === this.options.itemId)?.quantity ?? 0);

		if (inStorage <= 0) {
			return failed(`No ${this.options.itemId} available in faction storage`, 0);
		}

		let toWithdraw = inStorage;
		if (this.options.quantity !== undefined) {
			toWithdraw = Math.min(toWithdraw, this.options.quantity);
		}

		log.info(
			`Withdrawing ${toWithdraw}x ${this.options.itemId} from faction storage to station storage`,
		);

		// Use deposit with source: "faction" to move items/credits from faction storage
		// into personal station storage, bypassing the ship's cargo hold entirely.
		await ctx.endpoints.depositToStorage(this.options.itemId, toWithdraw, "faction");

		return succeeded(`Withdrew ${toWithdraw}x ${this.options.itemId} from faction storage`, 1);
	}
}
