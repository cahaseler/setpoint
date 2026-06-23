import { createLogger } from "../../util/logger.js";
import { countBulkStorageResults } from "../bulk-results.js";
import { actionableStacks } from "../cargo.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:ensure-empty-cargo");

export interface EnsureEmptyCargoOptions {
	/** Where to deposit cargo. Defaults to "personal" (base storage). */
	depositTarget?: "personal" | "faction";
}

/**
 * Ensure the ship's cargo hold is empty by depositing all items into storage.
 *
 * Already satisfied if cargo is empty (no items).
 * Prerequisites: must be docked at a station.
 *
 * All items are deposited in one bulk call (batched at 50 item types per tick).
 */
export class EnsureEmptyCargo implements Goal {
	readonly name = "ensure-empty-cargo";
	private readonly options: EnsureEmptyCargoOptions;

	constructor(options: EnsureEmptyCargoOptions = {}) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot empty cargo: must be docked at a station", 0);
		}

		// Query live cargo — deposit responses don't include V2GameState updates.
		const cargoResponse = await ctx.endpoints.getCargo();
		const cargo = cargoResponse.structuredContent.cargo;

		if (!cargo || cargo.length === 0) {
			return alreadySatisfied("Cargo is already empty");
		}

		const toFaction = (this.options.depositTarget ?? "personal") === "faction";
		const dest = toFaction ? "faction storage" : "storage";
		const items = actionableStacks(cargo).map((s) => ({ itemId: s.item_id, quantity: s.quantity }));

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
			const response = toFaction
				? await ctx.endpoints.depositToFactionStorageBulk(batch)
				: await ctx.endpoints.depositToStorageBulk(batch);
			depositedCount += countBulkStorageResults(response, "deposit", log).succeeded;
			ticksUsed++;
		}

		if (ticksUsed === 0) {
			return alreadySatisfied("Cargo is already empty");
		}

		return succeeded(`Deposited ${depositedCount} item type(s) to ${dest}`, ticksUsed);
	}
}
