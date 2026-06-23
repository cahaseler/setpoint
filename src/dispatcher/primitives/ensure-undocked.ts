import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, succeeded } from "../goals.js";

const log = createLogger("goal:ensure-undocked");

/**
 * Ensure the ship is undocked (in space).
 *
 * Already satisfied if not currently docked anywhere.
 * Prerequisites: none.
 */
export class EnsureUndocked implements Goal {
	readonly name = "ensure-undocked";

	async execute(ctx: GoalContext): Promise<GoalResult> {
		const dockedAt = ctx.state.location?.docked_at;

		if (!dockedAt) {
			return alreadySatisfied("Already undocked");
		}

		log.info(`Undocking from ${dockedAt}`);
		await ctx.endpoints.undock();

		return succeeded(`Undocked from ${dockedAt}`, 1);
	}
}
