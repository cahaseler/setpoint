import type { StorageResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:transfer-storage");

/**
 * View result — the union member returned by action=view (has an `items` array).
 *
 * lib codegen bug: the vendored StorageResponse view branch omits `credits`
 * even though the live server includes it for target=faction (verified live).
 * The schema marks this branch additionalProperties:false and never declares it.
 */
type StorageViewResult = Extract<StorageResponse, { items: unknown }> & { credits?: number };

export interface TransferStorageOptions {
	/** Storage to take from: "self" (personal) or "faction". */
	source: "self" | "faction";
	/** Storage to deposit into: "self" (personal) or "faction". */
	target: "self" | "faction";
	/** Item ID to transfer, or "credits". */
	itemId: string;
	/** Maximum quantity to transfer. If omitted, transfers all available. */
	quantity?: number;
}

/**
 * Transfer items (or credits) directly between personal and faction storage
 * without going through cargo.
 *
 * Uses the storage deposit API with source= parameter for a single-tick
 * direct storage-to-storage transfer.
 *
 * Prerequisites: must be docked at a station.
 * Costs 1 tick.
 */
export class LibTransferStorage implements LibGoal {
	readonly name = "transfer-storage";
	private readonly options: TransferStorageOptions;

	constructor(options: TransferStorageOptions) {
		if (options.source === options.target) {
			throw new Error(`transfer-storage: source and target cannot both be "${options.source}"`);
		}
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot transfer storage: must be docked at a station", 0);
		}

		const { source, target, itemId } = this.options;
		const isCredits = itemId === "credits";

		// Check how much is available in the source storage
		const r = await ctx.account.commands.spacemolt_storage.view({ target: source });
		const view = r.structuredContent as StorageViewResult | undefined;
		const available = isCredits
			? (view?.credits ?? 0)
			: (view?.items?.find((i) => i.item_id === itemId)?.quantity ?? 0);

		if (available <= 0) {
			return alreadySatisfied(`No ${itemId} in ${source} storage`);
		}

		const toTransfer =
			this.options.quantity !== undefined ? Math.min(available, this.options.quantity) : available;

		if (toTransfer <= 0) {
			return alreadySatisfied("Nothing to transfer");
		}

		log.info(`Transferring ${toTransfer}x ${itemId}: ${source} storage → ${target} storage`);

		if (source === "self" && target === "faction") {
			await ctx.account.commands.spacemolt_storage.deposit({
				item_id: itemId,
				quantity: toTransfer,
				target: "faction",
				source: "storage",
			});
		} else {
			// source === "faction" && target === "self"
			await ctx.account.commands.spacemolt_storage.deposit({
				item_id: itemId,
				quantity: toTransfer,
				target: "self",
				source: "faction",
			});
		}

		return succeeded(`Transferred ${toTransfer}x ${itemId} from ${source} to ${target} storage`, 1);
	}
}
