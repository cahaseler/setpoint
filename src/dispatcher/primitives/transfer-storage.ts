import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:transfer-storage");

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
export class TransferStorage implements Goal {
	readonly name = "transfer-storage";
	private readonly options: TransferStorageOptions;

	constructor(options: TransferStorageOptions) {
		if (options.source === options.target) {
			throw new Error(`transfer-storage: source and target cannot both be "${options.source}"`);
		}
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot transfer storage: must be docked at a station", 0);
		}

		const { source, target, itemId } = this.options;
		const isCredits = itemId === "credits";

		// Check how much is available in the source storage
		let available: number;
		if (source === "faction") {
			const r = await ctx.endpoints.viewFactionStorage();
			available = isCredits
				? (r.structuredContent.credits ?? 0)
				: (r.structuredContent.items?.find((i) => i.item_id === itemId)?.quantity ?? 0);
		} else {
			const r = await ctx.endpoints.viewStorage();
			available = isCredits
				? (r.structuredContent.credits ?? 0)
				: (r.structuredContent.items?.find((i) => i.item_id === itemId)?.quantity ?? 0);
		}

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
			await ctx.endpoints.depositToFactionStorage(itemId, toTransfer, "storage");
		} else {
			// source === "faction" && target === "self"
			await ctx.endpoints.depositToStorage(itemId, toTransfer, "faction");
		}

		return succeeded(`Transferred ${toTransfer}x ${itemId} from ${source} to ${target} storage`, 1);
	}
}
