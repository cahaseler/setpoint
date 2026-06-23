import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";

const log = createLogger("goal:create-buy-order");

/**
 * Create a buy order on the market at the current station.
 *
 * This places a buy order for a specified item at a given price.
 * If there are existing sell orders at or below the price, they will
 * be filled immediately (partially or fully).
 *
 * Prerequisites: must be docked at a station.
 * Always costs 1 tick (mutation).
 */
export class CreateMarketBuyOrder implements Goal {
	readonly name = "create-buy-order";
	private readonly itemId: string;
	private readonly quantity: number;
	private readonly price: number;

	constructor(itemId: string, quantity: number, price: number) {
		this.itemId = itemId;
		this.quantity = quantity;
		this.price = price;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot create buy order: must be docked at a station", 0);
		}

		log.info(`Creating buy order: ${this.quantity}x ${this.itemId} @ ${this.price} credits each`);
		const response = await ctx.endpoints.createBuyOrder(this.itemId, this.quantity, this.price);

		const content = response.structuredContent;
		if ("results" in content) {
			// Bulk-mode response shape — only expected when the request sends an
			// orders array, but the response type is a union so handle it.
			const { total, succeeded: ok, failed: failures } = content.summary;
			if (failures > 0) {
				return failed(`Buy order failed: ${failures}/${total} orders rejected`, 1);
			}
			return succeeded(`Buy order created: ${ok}/${total} orders @ ${this.price} each`, 1);
		}
		const filled = content.quantity_filled ?? 0;
		const listed = content.quantity_listed ?? 0;

		return succeeded(
			`Buy order created: ${filled} filled, ${listed} listed @ ${this.price} each`,
			1,
		);
	}
}
