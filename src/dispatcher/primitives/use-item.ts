import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, succeeded } from "../goals.js";

const log = createLogger("goal:use-item");

export interface UseItemOptions {
	itemId: string;
}

/**
 * Use a consumable item from cargo.
 *
 * Already satisfied if the item is not in cargo.
 */
export class UseItem implements Goal {
	readonly name = "use-item";
	private readonly options: UseItemOptions;

	constructor(options: UseItemOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		// Query live cargo to avoid stale state.
		const cargoResponse = await ctx.endpoints.getCargo();
		const cargo = cargoResponse.structuredContent.cargo;
		const item = cargo?.find((c) => c.item_id === this.options.itemId);

		if (!item || (item.quantity ?? 0) <= 0) {
			return alreadySatisfied(`Item ${this.options.itemId} not in cargo`);
		}

		log.info(`Using item: ${item.item_name ?? this.options.itemId}`);
		const response = await ctx.endpoints.useItem(this.options.itemId);
		const result = response.structuredContent;

		log.info(`Used ${result.quantity_used}x ${result.item_name} (effect: ${result.effect_type})`);

		return succeeded(
			`Used ${result.item_name}: ${result.effect_type} (${result.quantity_remaining} remaining)`,
			1,
		);
	}
}
