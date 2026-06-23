import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";

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
export class GiftToPlayer implements Goal {
	readonly name = "gift-to-player";
	private readonly options: GiftToPlayerOptions;

	constructor(options: GiftToPlayerOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot gift to player: must be docked at a station", 0);
		}

		const { itemId, quantity, targetName, message } = this.options;

		if (itemId === "credits") {
			// For credits, query live state to check balance.
			const stateResponse = await ctx.endpoints.getState();
			const available = stateResponse.structuredContent.player?.credits ?? 0;
			if (available < quantity) {
				return failed(`Insufficient credits to gift: have ${available}, need ${quantity}`, 0);
			}
			log.info(`Gifting ${quantity} credits to ${targetName}`);
			await ctx.endpoints.giftToPlayer(targetName, itemId, quantity, message);
			return succeeded(`Gifted ${quantity} credits to ${targetName}`, 1);
		}

		// Query live cargo to avoid stale state.
		const cargoResponse = await ctx.endpoints.getCargo();
		const liveCargo = cargoResponse.structuredContent.cargo;
		const inCargo = liveCargo?.find((c) => c.item_id === itemId)?.quantity ?? 0;
		if (inCargo <= 0) {
			return failed(`No ${itemId} in cargo to gift`, 0);
		}

		const toGift = Math.min(quantity, inCargo);
		log.info(`Gifting ${toGift}x ${itemId} to ${targetName}`);
		await ctx.endpoints.giftToPlayer(targetName, itemId, toGift, message);
		return succeeded(`Gifted ${toGift}x ${itemId} to ${targetName}`, 1);
	}
}
