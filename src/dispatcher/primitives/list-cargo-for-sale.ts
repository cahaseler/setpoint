import { createLogger } from "../../util/logger.js";
import { actionableStacks, stackName } from "../cargo.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:list-cargo-for-sale");

export interface ListCargoForSaleOptions {
	items: Array<{
		itemId: string;
		minPrice: number;
	}>;
}

/**
 * Create sell orders for cargo items at configured minimum prices.
 *
 * For each cargo item that matches the configured items list,
 * creates a sell order at the specified minimum price.
 *
 * Prerequisites: must be docked at a station.
 * Costs 1 tick per item type listed.
 */
export class ListCargoForSale implements Goal {
	readonly name = "list-cargo-for-sale";
	private readonly options: ListCargoForSaleOptions;

	constructor(options: ListCargoForSaleOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot list cargo for sale: must be docked at a station", 0);
		}

		// Query live cargo — sell responses don't include V2GameState updates.
		const cargoResponse = await ctx.endpoints.getCargo();
		const cargo = cargoResponse.structuredContent.cargo;
		if (!cargo || cargo.length === 0) {
			return alreadySatisfied("Cargo is empty, nothing to list");
		}

		// Build lookup from item config
		const priceByItemId = new Map<string, number>();
		for (const entry of this.options.items) {
			priceByItemId.set(entry.itemId, entry.minPrice);
		}

		let ticksUsed = 0;
		const listed: string[] = [];

		for (const item of actionableStacks(cargo)) {
			// Check for external cancellation between items — each listing costs
			// one tick (~10s), so a large cargo list could hold a force abort for
			// minutes if we did not stop here.
			if (ctx.signal?.aborted) {
				return failed(`Listing aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}

			const displayName = stackName(item);
			const minPrice = priceByItemId.get(item.item_id);
			if (minPrice === undefined) {
				log.info(`${displayName}: not in sell list, skipping`);
				continue;
			}

			log.info(`Listing ${item.quantity}x ${displayName} @ ${minPrice}cr each`);
			await ctx.endpoints.createSellOrder(item.item_id, item.quantity, minPrice);
			ticksUsed++;
			listed.push(`${item.quantity}x ${displayName} @ ${minPrice}`);
		}

		if (ticksUsed === 0) {
			return alreadySatisfied("No matching cargo items to list for sale");
		}

		return succeeded(`Listed ${listed.length} item type(s): ${listed.join(", ")}`, ticksUsed);
	}
}
