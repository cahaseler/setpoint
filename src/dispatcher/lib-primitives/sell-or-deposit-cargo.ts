import type {
	CreateSellOrderResponse,
	DepositItemsResponse,
	ViewMarketResponse,
} from "@spacemolt/lib";
import { type Logger, createLogger } from "../../util/logger.js";
import { actionableStacks } from "../cargo.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:sell-or-deposit-cargo");

/** A single item's market data, as returned in the `view_market` items array. */
type MarketItem = ViewMarketResponse["items"][number];

/** Bulk sell-order result — the union member returned when `orders` is set (per-order outcomes). */
type BulkCreateSellResult = Extract<CreateSellOrderResponse, { results: unknown[] }>;

/** Bulk deposit result — the union member returned when `items` is set (per-item outcomes). */
type BulkDepositResult = Extract<DepositItemsResponse, { results: unknown[] }>;

/** Options for the SellOrDepositCargo goal. */
export interface SellOrDepositCargoOptions {
	/** Where to deposit items with no market buyers. Defaults to "personal". */
	depositTarget?: "personal" | "faction";
	/**
	 * When true, skip the market check and deposit all items directly to
	 * the configured depositTarget without checking for buy orders.
	 * Defaults to false.
	 */
	skipMarket?: boolean;
	/**
	 * When set, create sell orders for all cargo at this price instead of
	 * depositing to storage. Buy orders at or above this price fill immediately;
	 * remaining quantity is listed on the market at this price.
	 * Mutually exclusive with skipMarket and depositTarget.
	 */
	listPrice?: number;
	/**
	 * Per-item sell prices, keyed by item_id. Takes precedence over listPrice
	 * for matching items. Items not in this map fall back to listPrice, then
	 * to the normal sell-or-deposit logic.
	 */
	listPrices?: Record<string, number>;
}

/**
 * Sell cargo items that have market buyers, deposit the rest to storage.
 *
 * Already satisfied if cargo is empty (no items).
 * Prerequisites: must be docked at a station.
 *
 * Steps:
 * 1. Query view_market() to discover which items have active buy orders (no tick cost)
 * 2. Items with a price (configured or matched buyers) are listed in one bulk
 *    create_sell_order call; the rest are deposited in one bulk deposit call.
 *    Each bulk call costs a single tick (batched at 50 item types per tick).
 */
export class LibSellOrDepositCargo implements LibGoal {
	readonly name = "sell-or-deposit-cargo";
	private readonly depositTarget: "personal" | "faction";
	private readonly skipMarket: boolean;
	private readonly listPrice: number | undefined;
	private readonly listPrices: Record<string, number> | undefined;

	constructor(options: SellOrDepositCargoOptions = {}) {
		this.depositTarget = options.depositTarget ?? "personal";
		this.skipMarket = options.skipMarket ?? false;
		this.listPrice = options.listPrice;
		this.listPrices = options.listPrices;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot sell/deposit cargo: must be docked at a station", 0);
		}

		// Cargo is part of the push-fed cache — no live query needed.
		const cargo = ctx.state.cargo;

		const stacks = actionableStacks(cargo);
		if (stacks.length === 0) {
			return alreadySatisfied("Cargo is already empty");
		}

		const hasAnyListPrice = this.listPrice !== undefined || this.listPrices !== undefined;

		// Query market for buy orders (no tick cost) — skipped when skipMarket or all items have prices
		const marketByItemId = new Map<string, MarketItem>();
		if (!this.skipMarket && !hasAnyListPrice) {
			const marketResponse = await ctx.account.commands.spacemolt_market.view_market();
			const marketItems = marketResponse.structuredContent?.items ?? [];
			for (const item of marketItems) {
				marketByItemId.set(item.item_id, item);
			}
		}

		// Partition cargo: items with a price (configured or matched against an
		// active buy order) become sell orders; everything else is deposited.
		// Both halves move in bulk — one tick per 50 item types.
		const sellOrders: Array<{ itemId: string; quantity: number; price: number }> = [];
		const deposits: Array<{ itemId: string; quantity: number }> = [];
		for (const item of stacks) {
			const itemPrice = this.listPrices?.[item.item_id] ?? this.listPrice;
			if (itemPrice !== undefined) {
				sellOrders.push({ itemId: item.item_id, quantity: item.quantity, price: itemPrice });
			} else {
				const bestBuy = this.skipMarket ? 0 : (marketByItemId.get(item.item_id)?.best_buy ?? 0);
				if (bestBuy > 0) {
					sellOrders.push({ itemId: item.item_id, quantity: item.quantity, price: bestBuy });
				} else {
					deposits.push({ itemId: item.item_id, quantity: item.quantity });
				}
			}
		}

		const BULK_LIMIT = 50;
		const depositToFaction = this.depositTarget === "faction";
		let ticksUsed = 0;
		let listedCount = 0;
		let depositedCount = 0;

		// List sell orders in bulk batches (up to 50 item types per tick).
		for (let i = 0; i < sellOrders.length; i += BULK_LIMIT) {
			// Check for external cancellation between batches — each bulk call
			// costs one tick (~10s), so a force abort must not wait for them all.
			if (ctx.signal?.aborted) {
				return failed(`Sell/deposit aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}
			const batch = sellOrders.slice(i, i + BULK_LIMIT);
			log.info(`Listing ${batch.length} item type(s) on market in bulk`);
			const response = await ctx.account.commands.spacemolt_market.create_sell_order({
				orders: batch.map((o) => ({
					item_id: o.itemId,
					quantity: o.quantity,
					price_each: o.price,
				})),
			});
			listedCount += this.countSellResults(response.delta.details, log);
			ticksUsed++;
		}

		// Deposit unsold items in bulk batches.
		for (let i = 0; i < deposits.length; i += BULK_LIMIT) {
			if (ctx.signal?.aborted) {
				return failed(`Sell/deposit aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}
			const batch = deposits.slice(i, i + BULK_LIMIT);
			const target = depositToFaction ? "faction storage" : "storage";
			log.info(`Depositing ${batch.length} item type(s) to ${target} in bulk`);
			const response = await ctx.account.commands.spacemolt_storage.deposit({
				items: batch.map((i) => ({
					item_id: i.itemId,
					quantity: i.quantity,
				})),
				target: depositToFaction ? "faction" : "self",
			});
			depositedCount += this.countDepositResults(response.delta.details, target, log);
			ticksUsed++;
		}

		if (ticksUsed === 0) {
			return alreadySatisfied("Cargo is already empty");
		}

		const parts: string[] = [];
		if (listedCount > 0) {
			parts.push(`${listedCount} listed on market`);
		}
		if (depositedCount > 0) {
			parts.push(
				`${depositedCount} deposited to ${depositToFaction ? "faction storage" : "storage"}`,
			);
		}

		return succeeded(`Processed cargo in ${ticksUsed} tick(s): ${parts.join(", ")}`, ticksUsed);
	}

	/**
	 * Count real successes in a bulk sell-order result, logging any per-item
	 * failures. A result reporting `success: true` but no `order_id` is a real
	 * failure: the game server escrows then returns the items when the player
	 * can't afford the listing fee, so the order never actually exists.
	 */
	private countSellResults(details: unknown, logger: Logger): number {
		const bulk = details as BulkCreateSellResult | undefined;
		if (!bulk?.results) {
			// No structured per-item breakdown — assume the batch succeeded.
			return 1;
		}
		let succeeded = 0;
		for (const result of bulk.results) {
			if (!result.success) {
				logger.warn(
					`Bulk create sell order #${result.index} failed: ${result.error_code ?? "unknown"} — ${result.error ?? "no details"}`,
				);
			} else if (!result.order_id) {
				logger.warn(
					`Bulk create sell order #${result.index} reported success but no order_id — order was not actually created (${result.message ?? "no details"})`,
				);
			} else {
				succeeded++;
			}
		}
		if (succeeded < bulk.results.length) {
			logger.warn(
				`Bulk create sell order: ${succeeded} succeeded, ${bulk.results.length - succeeded} failed out of ${bulk.results.length}`,
			);
		}
		return succeeded;
	}

	/** Count real successes in a bulk deposit result, logging any per-item failures. */
	private countDepositResults(details: unknown, dest: string, logger: Logger): number {
		const bulk = details as BulkDepositResult | undefined;
		if (!bulk?.results) {
			// No structured per-item breakdown — assume the batch succeeded.
			return 1;
		}
		let succeeded = 0;
		for (const result of bulk.results) {
			if (result.success) {
				succeeded++;
			} else {
				logger.warn(
					`Bulk deposit to ${dest} ${result.item_id} failed: ${result.error ?? result.message ?? "no details"}`,
				);
			}
		}
		if (succeeded < bulk.results.length) {
			logger.warn(
				`Bulk deposit to ${dest}: ${succeeded} succeeded, ${bulk.results.length - succeeded} failed out of ${bulk.results.length}`,
			);
		}
		return succeeded;
	}
}
