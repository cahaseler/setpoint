import type { BulkCancelOrdersResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:cancel-orders");

const BULK_LIMIT = 50;

/** Bulk cancel result — the union member returned when `order_ids` is set (per-order outcomes). */
type BulkCancelResult = BulkCancelOrdersResponse;

export interface CancelOrdersOptions {
	/** Order IDs to cancel. Up to 50 are cancelled per tick. */
	orderIds: string[];
}

/**
 * Cancel one or more open market orders at the current station.
 *
 * The game API supports cancelling up to 50 orders per tick via the bulk
 * cancel endpoint. This goal batches the provided order IDs into groups of 50
 * and issues one mutation per batch.
 *
 * Prerequisites: must be docked at a station.
 * Costs 1 tick per batch of 50.
 */
export class LibCancelOrders implements LibGoal {
	readonly name = "cancel-orders";
	private readonly options: CancelOrdersOptions;

	constructor(options: CancelOrdersOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot cancel orders: must be docked at a station", 0);
		}

		const { orderIds } = this.options;

		if (orderIds.length === 0) {
			return failed("Cannot cancel orders: orderIds array is empty", 0);
		}

		let ticksUsed = 0;
		let cancelled = 0;
		let failed_ = 0;

		for (let i = 0; i < orderIds.length; i += BULK_LIMIT) {
			// Check for external cancellation between batches — a marketbook can hold
			// many orders, and a force abort must not wait for every batch to finish.
			if (ctx.signal?.aborted) {
				return failed(`Order cancellation aborted after ${ticksUsed} batch(es)`, ticksUsed);
			}

			const batch = orderIds.slice(i, i + BULK_LIMIT);
			log.info(
				`Cancelling ${batch.length} order(s) in bulk (batch ${Math.floor(i / BULK_LIMIT) + 1})`,
			);

			const response = await ctx.account.commands.spacemolt_market.cancel_order({
				order_ids: batch,
			});
			ticksUsed++;

			const details = response.delta.details as BulkCancelResult | undefined;
			cancelled += details?.summary.succeeded ?? 0;
			failed_ += details?.summary.failed ?? 0;
		}

		const msg =
			failed_ > 0
				? `Cancelled ${cancelled} order(s), ${failed_} failed`
				: `Cancelled ${cancelled} order(s)`;

		return succeeded(msg, ticksUsed);
	}
}
