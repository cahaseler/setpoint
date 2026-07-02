import type { CompleteMissionResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:complete-mission");

export interface CompleteMissionOptions {
	missionId: string;
}

/**
 * Complete an active mission by ID.
 *
 * Prerequisites: must have the mission active and its objectives met.
 */
export class LibCompleteMission implements LibGoal {
	readonly name = "complete-mission";
	private readonly options: CompleteMissionOptions;

	constructor(options: CompleteMissionOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		log.info(`Completing mission: ${this.options.missionId}`);
		const response = await ctx.account.commands.spacemolt.complete_mission({
			id: this.options.missionId,
		});
		const result = response.delta.details as CompleteMissionResponse | undefined;

		const creditsEarned = result?.credits_earned ?? 0;
		log.info(`Completed mission: ${result?.title} (earned ${creditsEarned} credits)`);

		return succeeded(`Completed mission: ${result?.title} (+${creditsEarned} credits)`, 1);
	}
}
