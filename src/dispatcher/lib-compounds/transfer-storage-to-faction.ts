import type { StorageResponse } from "@spacemolt/lib";
import { SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult, GoalResult, StepResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:transfer-storage-to-faction");

/** Regex to parse faction storage cap error messages. */
const CAP_ERROR_REGEX = /already has (\d+) of .+?\(cap: (\d+)\)/;

/**
 * View result — the union member returned by action=view (has an `items` array).
 *
 * Upstream spec gap: the vendored StorageResponse view branch omits `credits`
 * even though the live server includes it (see also
 * lib-primitives/ensure-credits-from-faction.ts, verified live for target=faction).
 * The schema marks this branch additionalProperties:false and never declares it.
 */
type StorageViewResult = Extract<StorageResponse, { items: unknown }> & { credits?: number };

/**
 * Transfer all items and credits from personal storage to faction storage.
 *
 * Uses the deposit command's `source: "storage"` parameter for direct
 * personal→faction transfer in a single call per item (no cargo involved).
 * Returns alreadySatisfied when personal storage is empty or everything
 * remaining is at faction storage cap.
 *
 * Handles faction storage capacity limits gracefully:
 * - If an item is partially at cap, transfers only the remaining capacity.
 * - If an item is fully at cap, skips it.
 * - One item at cap does not prevent other items from being transferred.
 *
 * Prerequisites: must be docked at a station.
 * Costs 1 tick per item type + 1 tick for credits if present.
 */
export interface TransferStorageToFactionOptions {
	/** Skip transferring credits to faction storage. Default: false. */
	excludeCredits?: boolean;
}

export class LibTransferStorageToFaction implements LibGoal {
	readonly name = "transfer-storage-to-faction";
	private readonly options: TransferStorageToFactionOptions;

	constructor(options: TransferStorageToFactionOptions = {}) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<CompoundGoalResult> {
		if (!ctx.state.location?.docked_at) {
			return {
				success: false,
				message: "Cannot transfer storage: must be docked at a station",
				alreadySatisfied: false,
				ticksUsed: 0,
				steps: [],
			};
		}

		// Query personal storage
		const storageResponse = await ctx.account.commands.spacemolt_storage.view({ target: "self" });
		const view = storageResponse.structuredContent as StorageViewResult | undefined;
		const items = view?.items ?? [];
		const credits = view?.credits ?? 0;

		if (items.length === 0 && credits <= 0) {
			return {
				success: true,
				message: "Personal storage is empty — nothing to transfer",
				alreadySatisfied: true,
				ticksUsed: 0,
				steps: [],
			};
		}

		log.info(
			`Transferring ${items.length} item type(s) and ${credits} credits from personal to faction storage`,
		);

		// Process each item independently — don't let one cap error stop others.
		const stepResults: StepResult[] = [];
		let totalTicks = 0;
		let transferredCount = 0;
		let skippedAtCap = 0;

		for (const item of items) {
			// Check for external cancellation between items — personal storage can
			// hold dozens of item types, and a force abort must not wait for them all.
			if (ctx.signal?.aborted) {
				return {
					success: false,
					message: `Storage transfer aborted after ${transferredCount} item type(s)`,
					alreadySatisfied: false,
					ticksUsed: totalTicks,
					steps: stepResults,
				};
			}

			if (item.quantity <= 0) continue;

			const result = await this.transferItem(ctx, item.item_id, item.quantity);
			stepResults.push({ goalName: `transfer-${item.item_id}`, result });
			totalTicks += result.ticksUsed;

			if (result.success && !result.alreadySatisfied) {
				transferredCount++;
			} else if (result.alreadySatisfied) {
				skippedAtCap++;
			}
		}

		if (credits > 0 && !this.options.excludeCredits) {
			const result = await this.transferItem(ctx, "credits", credits);
			stepResults.push({ goalName: "transfer-credits", result });
			totalTicks += result.ticksUsed;

			if (result.success && !result.alreadySatisfied) {
				transferredCount++;
			} else if (result.alreadySatisfied) {
				skippedAtCap++;
			}
		}

		// If nothing was transferred, treat as alreadySatisfied to stop the loop.
		const nothingTransferred = transferredCount === 0;
		const totalItems = items.length + (credits > 0 ? 1 : 0);

		if (nothingTransferred) {
			return {
				success: true,
				message: `Nothing transferred — ${skippedAtCap} item(s) at faction storage cap`,
				alreadySatisfied: true,
				ticksUsed: totalTicks,
				steps: stepResults,
			};
		}

		return {
			success: true,
			message: `Transferred ${transferredCount}/${totalItems} item type(s)${
				skippedAtCap > 0 ? `, ${skippedAtCap} at cap` : ""
			} (${totalTicks} tick(s))`,
			alreadySatisfied: false,
			ticksUsed: totalTicks,
			steps: stepResults,
		};
	}

	/**
	 * Attempt to transfer a single item from personal to faction storage.
	 *
	 * On cap error: parses remaining capacity and retries with a reduced
	 * quantity. Returns alreadySatisfied if remaining capacity is zero.
	 */
	private async transferItem(
		ctx: LibGoalContext,
		itemId: string,
		quantity: number,
	): Promise<GoalResult> {
		try {
			log.info(`Transferring ${quantity}x ${itemId}: personal storage → faction storage`);
			await ctx.account.commands.spacemolt_storage.deposit({
				item_id: itemId,
				quantity,
				target: "faction",
				source: "storage",
			});
			return succeeded(`Transferred ${quantity}x ${itemId} to faction storage`, 1);
		} catch (err) {
			if (!(err instanceof SpacemoltError)) throw err;

			// Try to parse cap information from the error message
			const match = CAP_ERROR_REGEX.exec(err.message);
			if (!match) throw err;

			const current = Number.parseInt(match[1] as string, 10);
			const cap = Number.parseInt(match[2] as string, 10);
			const remaining = cap - current;

			if (remaining <= 0) {
				log.warn(`Skipping ${itemId}: faction storage at cap (${current}/${cap})`);
				return {
					success: true,
					message: `Skipped ${itemId}: faction storage at cap (${current}/${cap})`,
					alreadySatisfied: true,
					ticksUsed: 0,
				};
			}

			// Transfer only what fits
			const transferAmount = Math.min(quantity, remaining);
			log.info(
				`Faction storage has ${current}/${cap} of ${itemId}, transferring ${transferAmount} (of ${quantity} available)`,
			);

			try {
				await ctx.account.commands.spacemolt_storage.deposit({
					item_id: itemId,
					quantity: transferAmount,
					target: "faction",
					source: "storage",
				});
				return succeeded(
					`Transferred ${transferAmount}x ${itemId} to faction storage (capped at ${cap}, had ${current})`,
					1,
				);
			} catch (retryErr) {
				if (!(retryErr instanceof SpacemoltError)) throw retryErr;
				log.warn(
					`Failed to transfer ${transferAmount}x ${itemId} even with reduced quantity: ${retryErr.message}`,
				);
				return failed(`Could not transfer ${itemId}: ${retryErr.message}`, 0);
			}
		}
	}
}
