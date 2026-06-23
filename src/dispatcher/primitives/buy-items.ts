import type { MarketItem } from "../../api/endpoints.js";
import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:buy-items");

export interface BuyItemsOptions {
	items: Array<{
		itemId: string;
		maxPrice: number;
		maxQuantity?: number;
	}>;
}

/**
 * Buy items from the market at a docked station, filtering by max price.
 *
 * For each item in the list (in priority order), checks if sell orders
 * exist at or below the max price, and buys as much as fits in cargo.
 *
 * Prerequisites: must be docked at a station.
 * Costs 1 tick per item type purchased.
 */
export class BuyItems implements Goal {
	readonly name = "buy-items";
	private readonly options: BuyItemsOptions;

	constructor(options: BuyItemsOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot buy items: must be docked at a station", 0);
		}

		if (this.options.items.length === 0) {
			return alreadySatisfied("No items configured for purchase");
		}

		const cargoCapacity = ctx.state.ship?.cargo_capacity;
		const cargoUsed = ctx.state.ship?.cargo_used;

		if (cargoCapacity === undefined || cargoUsed === undefined) {
			return failed("Cannot buy items: ship cargo info unknown", 0);
		}

		let freeSpace = cargoCapacity - cargoUsed;
		if (freeSpace <= 0) {
			return alreadySatisfied("Cargo hold is full, cannot buy anything");
		}

		// Query market (free, no tick cost)
		const marketResponse = await ctx.endpoints.viewMarket();
		const marketItems = marketResponse.structuredContent.items as MarketItem[];

		const marketByItemId = new Map<string, MarketItem>();
		for (const item of marketItems) {
			marketByItemId.set(item.item_id, item);
		}

		let ticksUsed = 0;
		const bought: string[] = [];

		for (const entry of this.options.items) {
			// Check for external cancellation between items — each buy costs one
			// tick (~10s), so a large item list could hold a force abort for
			// minutes if we did not stop here.
			if (ctx.signal?.aborted) {
				return failed(`Buying aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}

			if (freeSpace <= 0) {
				break;
			}

			const marketData = marketByItemId.get(entry.itemId);
			if (!marketData) {
				log.info(`${entry.itemId}: not found on market, skipping`);
				continue;
			}

			// Sum up sell orders at or below max price
			const sellOrders = marketData.sell_orders ?? [];
			let availableAtPrice = 0;
			for (const order of sellOrders) {
				if (order.price_each <= entry.maxPrice) {
					availableAtPrice += order.quantity;
				}
			}

			if (availableAtPrice <= 0) {
				log.info(`${entry.itemId}: no sell orders at or below ${entry.maxPrice}, skipping`);
				continue;
			}

			// Calculate how much to buy
			let toBuy = availableAtPrice;
			if (entry.maxQuantity !== undefined) {
				toBuy = Math.min(toBuy, entry.maxQuantity);
			}
			toBuy = Math.min(toBuy, freeSpace);

			if (toBuy <= 0) {
				continue;
			}

			log.info(`Buying ${toBuy}x ${entry.itemId} (max price: ${entry.maxPrice})`);
			const response = await ctx.endpoints.buy(entry.itemId, toBuy);
			ticksUsed++;

			const totalCost = response.structuredContent.total_cost ?? 0;
			const quantityBought = response.structuredContent.quantity ?? toBuy;
			freeSpace -= quantityBought;
			bought.push(`${quantityBought}x ${entry.itemId} for ${totalCost}cr`);
		}

		if (ticksUsed === 0) {
			return alreadySatisfied("No items available to buy at configured prices");
		}

		return succeeded(`Bought ${bought.length} item type(s): ${bought.join(", ")}`, ticksUsed);
	}
}
