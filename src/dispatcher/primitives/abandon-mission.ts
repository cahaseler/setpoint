import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { succeeded } from "../goals.js";

const log = createLogger("goal:abandon-mission");

export interface AbandonMissionOptions {
	missionId: string;
}

/**
 * Abandon an active mission by ID.
 *
 * This is always an action — abandoning is never "already satisfied".
 */
export class AbandonMission implements Goal {
	readonly name = "abandon-mission";
	private readonly options: AbandonMissionOptions;

	constructor(options: AbandonMissionOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		log.info(`Abandoning mission: ${this.options.missionId}`);
		const response = await ctx.endpoints.abandonMission(this.options.missionId);
		const result = response.structuredContent;

		const title = result["title"] as string | undefined;
		log.info(`Abandoned mission: ${title ?? this.options.missionId}`);

		return succeeded(`Abandoned mission: ${title ?? this.options.missionId}`, 1);
	}
}
