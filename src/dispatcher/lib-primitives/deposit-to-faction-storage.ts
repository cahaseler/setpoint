import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:deposit-to-faction-storage");

export interface DepositToFactionStorageOptions {
	itemId: string;
	quantity: number;
}

/**
 * Deposit an item from cargo into faction storage.
 *
 * Prerequisites: must be docked at a station, item must be in cargo.
 * Costs 1 tick.
 */
export class LibDepositToFactionStorage implements LibGoal {
	readonly name = "deposit-to-faction-storage";
	private readonly options: DepositToFactionStorageOptions;

	constructor(options: DepositToFactionStorageOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot deposit to faction storage: must be docked at a station", 0);
		}

		// Cargo is part of the push-fed cache — no live query needed.
		const cargo = ctx.state.cargo;

		const inCargo = cargo?.find((c) => c.item_id === this.options.itemId)?.quantity ?? 0;
		if (inCargo <= 0) {
			return failed(`No ${this.options.itemId} in cargo to deposit`, 0);
		}

		const toDeposit = Math.min(this.options.quantity, inCargo);
		log.info(`Depositing ${toDeposit}x ${this.options.itemId} to faction storage`);
		await ctx.account.commands.spacemolt_storage.deposit({
			item_id: this.options.itemId,
			quantity: toDeposit,
			target: "faction",
		});

		return succeeded(`Deposited ${toDeposit}x ${this.options.itemId} to faction storage`, 1);
	}
}
