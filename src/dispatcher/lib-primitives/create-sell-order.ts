import type { CreateSellOrderResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:create-sell-order");

/**
 * Create a sell order on the market at the current station.
 *
 * This places a sell order for a specified item at a given price.
 * Items are sourced from cargo and/or storage. If there are existing
 * buy orders at or above the price, they will be filled immediately.
 *
 * Prerequisites: must be docked at a station.
 * Always costs 1 tick (mutation).
 */
export class LibCreateSellOrder implements LibGoal {
	readonly name = "create-sell-order";
	private readonly itemId: string;
	private readonly quantity: number;
	private readonly price: number;

	constructor(itemId: string, quantity: number, price: number) {
		this.itemId = itemId;
		this.quantity = quantity;
		this.price = price;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot create sell order: must be docked at a station", 0);
		}

		log.info(`Creating sell order: ${this.quantity}x ${this.itemId} @ ${this.price} credits each`);
		const response = await ctx.account.commands.spacemolt_market.create_sell_order({
			item_id: this.itemId,
			quantity: this.quantity,
			price_each: this.price,
		});

		const content = response.delta.details as CreateSellOrderResponse | undefined;
		if (content && "results" in content) {
			// Bulk-mode response shape — only expected when the request sends an
			// orders array, but the response type is a union so handle it.
			const { total, succeeded: ok, failed: failures } = content.summary;
			if (failures > 0) {
				return failed(`Sell order failed: ${failures}/${total} orders rejected`, 1);
			}
			return succeeded(`Sell order created: ${ok}/${total} orders @ ${this.price} each`, 1);
		}
		const filled = content?.quantity_filled ?? 0;
		const listed = content?.quantity_listed ?? 0;
		const earned = content?.total_earned ?? 0;

		return succeeded(
			`Sell order created: ${filled} filled (+${earned} credits), ${listed} listed @ ${this.price} each`,
			1,
		);
	}
}
