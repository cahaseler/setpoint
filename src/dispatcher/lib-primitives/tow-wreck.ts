import { SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:tow-wreck");

/** Permanent-precondition prefix the tow-salvage loop watches for to stop instead of retrying. */
export const PERMANENT_PREFIX = "PERMANENT:";

/** Tow a wreck by id. Requires a tow-rig utility module fitted. */
export class LibTowWreck implements LibGoal {
	readonly name = "tow-wreck";
	private readonly wreckId: string;

	constructor(wreckId: string) {
		this.wreckId = wreckId;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		log.info(`Towing wreck ${this.wreckId}`);
		try {
			await ctx.account.commands.spacemolt_salvage.tow({ id: this.wreckId });
			return succeeded(`Towing wreck ${this.wreckId}`, 1);
		} catch (err) {
			if (err instanceof SpacemoltError) {
				if (/already.*tow|tow.*already/i.test(err.message)) {
					return alreadySatisfied(`Already towing ${this.wreckId}`);
				}
				if (/tow.?rig|no_tow_rig/i.test(`${err.code} ${err.message}`)) {
					return failed(
						`${PERMANENT_PREFIX} cannot tow — no tow-rig module fitted (${err.message})`,
						0,
					);
				}
			}
			throw err;
		}
	}
}
