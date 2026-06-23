import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, succeeded } from "../goals.js";

const log = createLogger("goal:jettison-cargo");

export interface JettisonCargoOptions {
	itemId: string;
	quantity: number;
}

/**
 * Jettison a specific item from cargo into space.
 *
 * Already satisfied if the item is not in cargo.
 * Prerequisites: must have the item in cargo.
 */
export class JettisonCargo implements Goal {
	readonly name = "jettison-cargo";
	private readonly options: JettisonCargoOptions;

	constructor(options: JettisonCargoOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		// Query live cargo — jettison responses don't include V2GameState updates.
		const cargoResponse = await ctx.endpoints.getCargo();
		const cargo = cargoResponse.structuredContent.cargo;
		if (!cargo || cargo.length === 0) {
			return alreadySatisfied("Cargo is empty, nothing to jettison");
		}

		const item = cargo.find((c) => c.item_id === this.options.itemId);
		if (!item || (item.quantity ?? 0) <= 0) {
			return alreadySatisfied(`Item ${this.options.itemId} not in cargo`);
		}

		const qty = Math.min(this.options.quantity, item.quantity ?? 0);
		log.info(`Jettisoning ${qty}x ${item.item_name ?? this.options.itemId}`);
		const response = await ctx.endpoints.jettison(this.options.itemId, qty);
		const result = response.structuredContent;

		return succeeded(`Jettisoned ${result.quantity}x ${result.item_name}`, 1);
	}
}
