import { createLogger } from "../../util/logger.js";
import { countBulkOrderResults } from "../bulk-results.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:ensure-marketbook");

/** A single desired market order in the target book. */
export interface TargetOrder {
	itemId: string;
	side: "buy" | "sell";
	quantity: number;
	price: number;
}

/** Options for the EnsureMarketbook compound goal. */
export interface EnsureMarketbookOptions {
	/** Array of desired orders to maintain in the market book. */
	targetOrders: TargetOrder[];
	/**
	 * Fraction (0.0–1.0) — an existing order price within this fraction of
	 * the target price is considered matching. Default: 0 (exact match).
	 */
	priceTolerance?: number;
	/**
	 * Cancel existing orders not present in the target list. Default: false.
	 */
	cancelUnmatched?: boolean;
}

/**
 * Sync the player's open market orders to a target configuration.
 *
 * Matching logic (per target order):
 * 1. Find existing orders with the same item+side.
 * 2. If price is within tolerance → keep (0 ticks).
 * 3. If price drifted beyond tolerance → modify_order (1 tick each,
 *    listing fee on price increases: difference × rate, minimum 1cr).
 * 4. If total remaining across all kept/modified orders < target qty,
 *    create a top-up order for the difference.
 * 5. No matching order at all → create new order.
 * 6. cancelUnmatched: true → cancel orders not matched to any target.
 *
 * Already satisfied if all targets match and no modifications needed.
 * Prerequisites: must be docked at a station.
 */
export class EnsureMarketbook implements Goal {
	readonly name = "ensure-marketbook";
	private readonly options: EnsureMarketbookOptions;

	constructor(options: EnsureMarketbookOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("ensure-marketbook requires being docked at a station", 0);
		}

		const priceTolerance = this.options.priceTolerance ?? 0;
		const cancelUnmatched = this.options.cancelUnmatched ?? false;

		// Fetch all current open orders across all pages (free query, 0 ticks)
		const existingOrders = await ctx.endpoints.viewAllOrders();

		// Track matched order IDs (existing orders that satisfy a target)
		const matchedOrderIds = new Set<string>();
		// Track order IDs already queued for cancel (avoid duplicates)
		const cancelledOrderIds = new Set<string>();

		const toCancel: Array<{ order_id: string; item_id: string }> = [];
		const toModify: Array<{ order_id: string; item_id: string; newPrice: number }> = [];
		const toCreate: TargetOrder[] = [];

		// Diff: for each target, find matching existing orders.
		// Consume good-price candidates first, then bad-price, stopping once the
		// target quantity is covered. Excess candidates remain unmatched and are
		// cancellable via cancelUnmatched.
		for (const target of this.options.targetOrders) {
			const candidates = existingOrders.filter(
				(o) =>
					o.item_id === target.itemId && o.side === target.side && !matchedOrderIds.has(o.order_id),
			);

			if (candidates.length === 0) {
				// No existing order for this item+side — create new
				toCreate.push(target);
				continue;
			}

			// Partition candidates into price-matched and price-drifted
			const goodPrice = candidates.filter((c) =>
				this.priceMatches(c.price_each, target.price, priceTolerance),
			);
			const badPrice = candidates.filter(
				(c) => !this.priceMatches(c.price_each, target.price, priceTolerance),
			);

			let coveredQty = 0;
			for (const order of [...goodPrice, ...badPrice]) {
				if (coveredQty >= target.quantity) break;
				const remaining = order.remaining ?? order.quantity;
				matchedOrderIds.add(order.order_id);
				coveredQty += remaining;
				if (this.priceMatches(order.price_each, target.price, priceTolerance)) {
					log.info(`Order ${order.order_id} (${target.itemId}/${target.side}) matches, keeping`);
				} else {
					toModify.push({
						order_id: order.order_id,
						item_id: order.item_id,
						newPrice: target.price,
					});
					log.info(
						`Order ${order.order_id} (${target.itemId}/${target.side}) price ${order.price_each} → ${target.price}, queuing modify`,
					);
				}
			}

			if (coveredQty < target.quantity) {
				const topUp = target.quantity - coveredQty;
				toCreate.push({ ...target, quantity: topUp });
				log.info(
					`${target.itemId}/${target.side}: ${coveredQty}/${target.quantity} covered, topping up ${topUp}`,
				);
			}
		}

		// If cancelUnmatched, also cancel existing orders not matched to any target
		if (cancelUnmatched) {
			for (const order of existingOrders) {
				if (!matchedOrderIds.has(order.order_id) && !cancelledOrderIds.has(order.order_id)) {
					cancelledOrderIds.add(order.order_id);
					toCancel.push({ order_id: order.order_id, item_id: order.item_id });
					log.info(
						`Queuing cancel of unmatched order ${order.order_id} (${order.item_id}/${order.side})`,
					);
				}
			}
		}

		// Already satisfied?
		if (toCancel.length === 0 && toModify.length === 0 && toCreate.length === 0) {
			return alreadySatisfied(`Market book already matches: ${matchedOrderIds.size} order(s) kept`);
		}

		let ticksUsed = 0;
		let cancelledCount = 0;
		let createdCount = 0;
		let failedCount = 0;
		const BULK_LIMIT = 50;

		// Cancel stale orders in bulk batches (up to 50 per tick)
		for (let i = 0; i < toCancel.length; i += BULK_LIMIT) {
			const batch = toCancel.slice(i, i + BULK_LIMIT);
			log.info(`Cancelling ${batch.length} order(s) in bulk`);
			const response = await ctx.endpoints.cancelOrdersBulk(batch.map((o) => o.order_id));
			const bulkResult = countBulkOrderResults(response, "cancel", log);
			cancelledCount += bulkResult.succeeded;
			failedCount += bulkResult.failed;
			ticksUsed++;
		}

		// Modify orders with drifted prices (1 tick each — no bulk modify API; price increases incur a listing fee)
		for (const mod of toModify) {
			// Check for external cancellation between orders — a managed marketbook
			// can have many orders, and a force abort must not wait for them all.
			if (ctx.signal?.aborted) {
				return failed(`Market book sync aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}

			log.info(`Modifying order ${mod.order_id} (${mod.item_id}) → price ${mod.newPrice}`);
			await ctx.endpoints.modifyOrder(mod.order_id, mod.newPrice);
			ticksUsed++;
		}

		// Create missing buy orders in bulk batches
		const toBuy = toCreate.filter((t) => t.side === "buy");
		for (let i = 0; i < toBuy.length; i += BULK_LIMIT) {
			// Check for external cancellation between batches — a managed marketbook
			// can have many orders, and a force abort must not wait for them all.
			if (ctx.signal?.aborted) {
				return failed(`Market book sync aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}

			const batch = toBuy.slice(i, i + BULK_LIMIT);
			log.info(`Creating ${batch.length} buy order(s) in bulk`);
			const response = await ctx.endpoints.createBuyOrdersBulk(
				batch.map((t) => ({ itemId: t.itemId, quantity: t.quantity, price: t.price })),
			);
			const bulkResult = countBulkOrderResults(response, "create buy", log);
			createdCount += bulkResult.succeeded;
			failedCount += bulkResult.failed;
			ticksUsed++;
		}

		// Create missing sell orders in bulk batches
		const toSell = toCreate.filter((t) => t.side === "sell");
		for (let i = 0; i < toSell.length; i += BULK_LIMIT) {
			// Check for external cancellation between batches — a managed marketbook
			// can have many orders, and a force abort must not wait for them all.
			if (ctx.signal?.aborted) {
				return failed(`Market book sync aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}

			const batch = toSell.slice(i, i + BULK_LIMIT);
			log.info(`Creating ${batch.length} sell order(s) in bulk`);
			const response = await ctx.endpoints.createSellOrdersBulk(
				batch.map((t) => ({ itemId: t.itemId, quantity: t.quantity, price: t.price })),
			);
			const bulkResult = countBulkOrderResults(response, "create sell", log);
			createdCount += bulkResult.succeeded;
			failedCount += bulkResult.failed;
			ticksUsed++;
		}

		const parts: string[] = [];
		if (matchedOrderIds.size > 0) parts.push(`${matchedOrderIds.size} kept`);
		if (toModify.length > 0) parts.push(`${toModify.length} modified`);
		if (cancelledCount > 0) parts.push(`${cancelledCount} cancelled`);
		if (createdCount > 0) parts.push(`${createdCount} created`);
		if (failedCount > 0) parts.push(`${failedCount} failed`);

		if (createdCount === 0 && cancelledCount === 0 && toModify.length === 0 && failedCount > 0) {
			return failed(
				`All bulk operations failed (${failedCount} failure(s), ${ticksUsed} ticks)`,
				ticksUsed,
			);
		}

		return succeeded(`Market book synced: ${parts.join(", ")} (${ticksUsed} ticks)`, ticksUsed);
	}

	private priceMatches(actual: number, target: number, tolerance: number): boolean {
		if (tolerance === 0) {
			return actual === target;
		}
		return Math.abs(actual - target) / target <= tolerance;
	}
}
