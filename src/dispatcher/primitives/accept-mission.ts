import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";

const log = createLogger("goal:accept-mission");

export interface AcceptMissionOptions {
	missionId: string;
}

/**
 * Accept an available mission by ID.
 *
 * This is always an action — accepting a mission is never "already satisfied".
 * Prerequisites: must be docked at the station offering the mission.
 */
export class AcceptMission implements Goal {
	readonly name = "accept-mission";
	private readonly options: AcceptMissionOptions;

	constructor(options: AcceptMissionOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot accept mission: must be docked", 0);
		}

		log.info(`Accepting mission: ${this.options.missionId}`);
		const response = await ctx.endpoints.acceptMission(this.options.missionId);
		const result = response.structuredContent;

		log.info(`Accepted mission: ${result.title}`);

		return succeeded(`Accepted mission: ${result.title}`, 1);
	}
}
