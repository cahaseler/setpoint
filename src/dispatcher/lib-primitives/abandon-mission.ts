import type { AbandonMissionResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:abandon-mission");

export interface AbandonMissionOptions {
	missionId: string;
}

/**
 * Abandon an active mission by ID.
 *
 * This is always an action — abandoning is never "already satisfied".
 */
export class LibAbandonMission implements LibGoal {
	readonly name = "abandon-mission";
	private readonly options: AbandonMissionOptions;

	constructor(options: AbandonMissionOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		log.info(`Abandoning mission: ${this.options.missionId}`);
		const response = await ctx.account.commands.spacemolt.abandon_mission({
			id: this.options.missionId,
		});
		const result = response.delta.details as AbandonMissionResponse | undefined;

		const title = result?.title;
		log.info(`Abandoned mission: ${title ?? this.options.missionId}`);

		return succeeded(`Abandoned mission: ${title ?? this.options.missionId}`, 1);
	}
}
