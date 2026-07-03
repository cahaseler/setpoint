import type { UseItemResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:use-item");

export interface UseItemOptions {
	itemId: string;
}

/**
 * Use a consumable item from cargo.
 *
 * Already satisfied if the item is not in cargo.
 */
export class LibUseItem implements LibGoal {
	readonly name = "use-item";
	private readonly options: UseItemOptions;

	constructor(options: UseItemOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		// Cargo is part of the push-fed cache — no live query needed.
		const cargo = ctx.state.cargo;
		const item = cargo?.find((c) => c.item_id === this.options.itemId);

		if (!item || (item.quantity ?? 0) <= 0) {
			return alreadySatisfied(`Item ${this.options.itemId} not in cargo`);
		}

		log.info(`Using item: ${item.item_name ?? this.options.itemId}`);
		const response = await ctx.account.commands.spacemolt.use_item({ id: this.options.itemId });
		const result = response.delta.details as UseItemResponse | undefined;

		log.info(
			`Used ${result?.quantity_used ?? 1}x ${result?.item_name ?? item.item_name ?? this.options.itemId} (effect: ${result?.effect_type ?? "unknown"})`,
		);

		return succeeded(
			`Used ${result?.item_name ?? item.item_name ?? this.options.itemId}: ${result?.effect_type ?? "unknown"} (${result?.quantity_remaining ?? 0} remaining)`,
			1,
		);
	}
}
