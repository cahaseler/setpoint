import type { JettisonResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:jettison-cargo");

export interface JettisonCargoOptions {
	itemId: string;
	quantity: number;
}

/** Single-item jettison result — the union member returned for a non-bulk jettison call. */
type SingleJettisonResult = Extract<JettisonResponse, { item_name: string }>;

/**
 * Jettison a specific item from cargo into space.
 *
 * Already satisfied if the item is not in cargo.
 * Prerequisites: must have the item in cargo.
 */
export class LibJettisonCargo implements LibGoal {
	readonly name = "jettison-cargo";
	private readonly options: JettisonCargoOptions;

	constructor(options: JettisonCargoOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		// Cargo is part of the push-fed cache — no live query needed.
		const cargo = ctx.state.cargo;
		if (!cargo || cargo.length === 0) {
			return alreadySatisfied("Cargo is empty, nothing to jettison");
		}

		const item = cargo.find((c) => c.item_id === this.options.itemId);
		if (!item || (item.quantity ?? 0) <= 0) {
			return alreadySatisfied(`Item ${this.options.itemId} not in cargo`);
		}

		const qty = Math.min(this.options.quantity, item.quantity ?? 0);
		log.info(`Jettisoning ${qty}x ${item.item_name ?? this.options.itemId}`);
		const response = await ctx.account.commands.spacemolt.jettison({
			id: this.options.itemId,
			quantity: qty,
		});
		const result = response.delta.details as SingleJettisonResult | undefined;

		return succeeded(
			`Jettisoned ${result?.quantity ?? qty}x ${result?.item_name ?? item.item_name ?? this.options.itemId}`,
			1,
		);
	}
}
