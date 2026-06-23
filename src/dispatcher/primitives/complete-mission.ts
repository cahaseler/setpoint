import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { succeeded } from "../goals.js";

const log = createLogger("goal:complete-mission");

export interface CompleteMissionOptions {
	missionId: string;
}

/**
 * Complete an active mission by ID.
 *
 * Prerequisites: must have the mission active and its objectives met.
 */
export class CompleteMission implements Goal {
	readonly name = "complete-mission";
	private readonly options: CompleteMissionOptions;

	constructor(options: CompleteMissionOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		log.info(`Completing mission: ${this.options.missionId}`);
		const response = await ctx.endpoints.completeMission(this.options.missionId);
		const result = response.structuredContent;

		const creditsEarned = result.credits_earned ?? 0;
		log.info(`Completed mission: ${result.title} (earned ${creditsEarned} credits)`);

		return succeeded(`Completed mission: ${result.title} (+${creditsEarned} credits)`, 1);
	}
}
