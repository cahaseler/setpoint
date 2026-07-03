import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:gift-to-player");

export interface GiftToPlayerOptions {
	targetName: string;
	itemId: string;
	quantity: number;
	message?: string;
}

/**
 * Send items or credits to another player via the storage gift mechanism.
 *
 * For items: deposited from cargo to the target player's personal storage.
 * For credits: transferred directly from the player's credit balance.
 *
 * Prerequisites: must be docked at a station.
 * Costs 1 tick.
 */
export class LibGiftToPlayer implements LibGoal {
	readonly name = "gift-to-player";
	private readonly options: GiftToPlayerOptions;

	constructor(options: GiftToPlayerOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot gift to player: must be docked at a station", 0);
		}

		const { itemId, quantity, targetName, message } = this.options;

		if (itemId === "credits") {
			// Credits are part of the push-fed cache — no live query needed.
			const available = ctx.state.player?.credits ?? 0;
			if (available < quantity) {
				return failed(`Insufficient credits to gift: have ${available}, need ${quantity}`, 0);
			}
			log.info(`Gifting ${quantity} credits to ${targetName}`);
			await ctx.account.commands.spacemolt_storage.deposit({
				credits: quantity,
				target: targetName,
				...(message !== undefined ? { message } : {}),
			});
			return succeeded(`Gifted ${quantity} credits to ${targetName}`, 1);
		}

		// Cargo is part of the push-fed cache — no live query needed.
		const liveCargo = ctx.state.cargo;
		const inCargo = liveCargo?.find((c) => c.item_id === itemId)?.quantity ?? 0;
		if (inCargo <= 0) {
			return failed(`No ${itemId} in cargo to gift`, 0);
		}

		const toGift = Math.min(quantity, inCargo);
		log.info(`Gifting ${toGift}x ${itemId} to ${targetName}`);
		await ctx.account.commands.spacemolt_storage.deposit({
			item_id: itemId,
			quantity: toGift,
			target: targetName,
			...(message !== undefined ? { message } : {}),
		});
		return succeeded(`Gifted ${toGift}x ${itemId} to ${targetName}`, 1);
	}
}
