import type { AcceptMissionResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

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
export class LibAcceptMission implements LibGoal {
	readonly name = "accept-mission";
	private readonly options: AcceptMissionOptions;

	constructor(options: AcceptMissionOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot accept mission: must be docked", 0);
		}

		log.info(`Accepting mission: ${this.options.missionId}`);
		const response = await ctx.account.commands.spacemolt.accept_mission({
			id: this.options.missionId,
		});
		const result = response.delta.details as AcceptMissionResponse | undefined;

		log.info(`Accepted mission: ${result?.title}`);

		return succeeded(`Accepted mission: ${result?.title}`, 1);
	}
}
