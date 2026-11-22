import type { GameState, JettisonResponse } from "@spacemolt/lib";
import { SpacemoltError } from "@spacemolt/lib";
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
 *
 * The cached cargo can still list an item the ship no longer has: onboard
 * processors convert raw cargo between ticks and the game sends no push for
 * it. When the game answers `not_in_cargo`, the goal re-reads live cargo and
 * jettisons what is actually there, or is already satisfied if nothing is.
 */
export class LibJettisonCargo implements LibGoal {
	readonly name = "jettison-cargo";
	private readonly options: JettisonCargoOptions;

	constructor(options: JettisonCargoOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		// Cargo is part of the push-fed cache — no live query needed.
		const first = this.plan(ctx.state);
		if (first.done) return first.done;
		try {
			return await this.jettison(ctx, first.qty, first.itemName);
		} catch (err) {
			if (!(err instanceof SpacemoltError && err.code === "not_in_cargo")) throw err;
			log.warn(
				`Game reports no ${first.itemName} in cargo; the cached cargo was stale — re-reading it`,
			);
			const live = this.plan(await ctx.refreshState({ force: true }));
			if (live.done) return live.done;
			return this.jettison(ctx, live.qty, live.itemName);
		}
	}

	private plan(
		state: Readonly<GameState>,
	):
		| { done: GoalResult; qty?: never; itemName?: never }
		| { done?: never; qty: number; itemName: string } {
		const cargo = state.cargo;
		if (!cargo || cargo.length === 0) {
			return { done: alreadySatisfied("Cargo is empty, nothing to jettison") };
		}
		const item = cargo.find((c) => c.item_id === this.options.itemId);
		if (!item || (item.quantity ?? 0) <= 0) {
			return { done: alreadySatisfied(`Item ${this.options.itemId} not in cargo`) };
		}
		return {
			qty: Math.min(this.options.quantity, item.quantity ?? 0),
			itemName: item.item_name ?? this.options.itemId,
		};
	}

	private async jettison(ctx: LibGoalContext, qty: number, itemName: string): Promise<GoalResult> {
		log.info(`Jettisoning ${qty}x ${itemName}`);
		const response = await ctx.account.commands.spacemolt.jettison({
			id: this.options.itemId,
			quantity: qty,
		});
		const result = response.delta.details as SingleJettisonResult | undefined;

		return succeeded(`Jettisoned ${result?.quantity ?? qty}x ${result?.item_name ?? itemName}`, 1);
	}
}
