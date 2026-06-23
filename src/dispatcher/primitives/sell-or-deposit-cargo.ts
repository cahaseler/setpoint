import type { MarketItem } from "../../api/endpoints.js";
import { createLogger } from "../../util/logger.js";
import { countBulkOrderResults, countBulkStorageResults } from "../bulk-results.js";
import { actionableStacks } from "../cargo.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:sell-or-deposit-cargo");

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
 * 1. Query viewMarket() to discover which items have active buy orders (no tick cost)
 * 2. Items with a price (configured or matched buyers) are listed in one bulk
 *    create_sell_order call; the rest are deposited in one bulk deposit call.
 *    Each bulk call costs a single tick (batched at 50 item types per tick).
 */
export class SellOrDepositCargo implements Goal {
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

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot sell/deposit cargo: must be docked at a station", 0);
		}

		// Query live cargo from the API — queries are free (no tick cost).
		// Sell/deposit responses don't include V2GameState, so the state store
		// becomes stale after each operation. Using getCargo() ensures we always
		// work with the server's actual cargo, preventing "insufficient_cargo"
		// errors on retries after partial completion.
		const cargoResponse = await ctx.endpoints.getCargo();
		const cargo = cargoResponse.structuredContent.cargo;

		const stacks = actionableStacks(cargo);
		if (stacks.length === 0) {
			return alreadySatisfied("Cargo is already empty");
		}

		const hasAnyListPrice = this.listPrice !== undefined || this.listPrices !== undefined;

		// Query market for buy orders (no tick cost) — skipped when skipMarket or all items have prices
		const marketByItemId = new Map<string, MarketItem>();
		if (!this.skipMarket && !hasAnyListPrice) {
			const marketResponse = await ctx.endpoints.viewMarket();
			const marketItems = marketResponse.structuredContent.items as MarketItem[];
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
			const response = await ctx.endpoints.createSellOrdersBulk(batch);
			listedCount += countBulkOrderResults(response, "create sell", log).succeeded;
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
			const response = depositToFaction
				? await ctx.endpoints.depositToFactionStorageBulk(batch)
				: await ctx.endpoints.depositToStorageBulk(batch);
			depositedCount += countBulkStorageResults(response, "deposit", log).succeeded;
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
}
