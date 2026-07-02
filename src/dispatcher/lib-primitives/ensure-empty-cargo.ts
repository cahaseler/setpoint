import type { DepositItemsResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:ensure-empty-cargo");

export interface EnsureEmptyCargoOptions {
	/** Where to deposit cargo. Defaults to "personal" (base storage). */
	depositTarget?: "personal" | "faction";
}

/** Bulk deposit result — the union member returned when `items` is set (per-item outcomes). */
type BulkDepositResult = Extract<DepositItemsResponse, { results: unknown[] }>;

/**
 * Ensure the ship's cargo hold is empty by depositing all items into storage.
 *
 * Already satisfied if cargo is empty (no items).
 * Prerequisites: must be docked at a station.
 *
 * All items are deposited in one bulk call (batched at 50 item types per tick).
 */
export class LibEnsureEmptyCargo implements LibGoal {
	readonly name = "ensure-empty-cargo";
	private readonly options: EnsureEmptyCargoOptions;

	constructor(options: EnsureEmptyCargoOptions = {}) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot empty cargo: must be docked at a station", 0);
		}

		// Cargo is part of the push-fed cache — no live query needed.
		const cargo = ctx.state.cargo;

		if (!cargo || cargo.length === 0) {
			return alreadySatisfied("Cargo is already empty");
		}

		const toFaction = (this.options.depositTarget ?? "personal") === "faction";
		const dest = toFaction ? "faction storage" : "storage";
		const items = cargo
			.filter((s): s is typeof s & { item_id: string; quantity: number } => {
				return s.item_id !== undefined && (s.quantity ?? 0) > 0;
			})
			.map((s) => ({ item_id: s.item_id, quantity: s.quantity }));

		const BULK_LIMIT = 50;
		let ticksUsed = 0;
		let depositedCount = 0;

		for (let i = 0; i < items.length; i += BULK_LIMIT) {
			// Check for external cancellation between batches — each bulk deposit
			// costs one tick (~10s), so a force abort must not wait for them all.
			if (ctx.signal?.aborted) {
				return failed(`Deposit aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}

			const batch = items.slice(i, i + BULK_LIMIT);
			log.info(`Depositing ${batch.length} item type(s) to ${dest} in bulk`);
			const response = await ctx.account.commands.spacemolt_storage.deposit({
				// LIB BUG: SpacemoltStorageDepositParams.items is typed string[], but the
				// wire schema (SpacemoltStorageDepositData.body.items) and server both
				// expect {item_id, quantity}[] — the friendly command wrapper mistyped it.
				items: batch as unknown as string[],
				target: toFaction ? "faction" : "self",
			});
			depositedCount += this.countDepositResults(response.delta.details, dest);
			ticksUsed++;
		}

		if (ticksUsed === 0) {
			return alreadySatisfied("Cargo is already empty");
		}

		return succeeded(`Deposited ${depositedCount} item type(s) to ${dest}`, ticksUsed);
	}

	/** Count real successes in a bulk deposit result, logging any per-item failures. */
	private countDepositResults(details: unknown, dest: string): number {
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
				log.warn(
					`Bulk deposit to ${dest} ${result.item_id} failed: ${result.error ?? result.message ?? "no details"}`,
				);
			}
		}
		if (succeeded < bulk.results.length) {
			log.warn(
				`Bulk deposit to ${dest}: ${succeeded} succeeded, ${bulk.results.length - succeeded} failed out of ${bulk.results.length}`,
			);
		}
		return succeeded;
	}
}
