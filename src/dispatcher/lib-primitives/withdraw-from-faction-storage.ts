import type { StorageResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:withdraw-from-faction-storage");

/**
 * View result — the union member returned by action=view (has an `items` array).
 *
 * Upstream spec gap: the vendored StorageResponse view branch omits `credits`
 * (and other faction-only fields like `buckets`/`faction_id`) even though the
 * live server includes them for target=faction; the schema marks this branch
 * additionalProperties:false and never declares them. Verified live: view
 * target=faction returns a top-level `credits` (faction treasury balance).
 */
type StorageViewResult = Extract<StorageResponse, { items: unknown }> & { credits?: number };

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
export class LibWithdrawFromFactionStorage implements LibGoal {
	readonly name = "withdraw-from-faction-storage";
	private readonly options: WithdrawFromFactionStorageOptions;

	constructor(options: WithdrawFromFactionStorageOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot withdraw from faction storage: must be docked at a station", 0);
		}

		const isCredits = this.options.itemId === "credits";

		// Check faction storage for available quantity
		const storageResponse = await ctx.account.commands.spacemolt_storage.view({
			target: "faction",
		});
		const view = storageResponse.structuredContent as StorageViewResult | undefined;
		const storageItems = view?.items ?? [];
		const inStorage = isCredits
			? (view?.credits ?? 0)
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
		await ctx.account.commands.spacemolt_storage.deposit({
			item_id: this.options.itemId,
			quantity: toWithdraw,
			target: "self",
			source: "faction",
		});

		return succeeded(`Withdrew ${toWithdraw}x ${this.options.itemId} from faction storage`, 1);
	}
}
