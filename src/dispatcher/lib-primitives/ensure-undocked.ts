import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:ensure-undocked");

/**
 * Ensure the ship is undocked (in space).
 *
 * Already satisfied if not currently docked anywhere.
 * Prerequisites: none.
 */
export class LibEnsureUndocked implements LibGoal {
	readonly name = "ensure-undocked";

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		const dockedAt = ctx.state.location?.docked_at;

		if (!dockedAt) {
			return alreadySatisfied("Already undocked");
		}

		log.info(`Undocking from ${dockedAt}`);
		await ctx.account.commands.spacemolt.undock();

		return succeeded(`Undocked from ${dockedAt}`, 1);
	}
}
