import { ApiError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import {
	type Goal,
	type GoalContext,
	type GoalResult,
	alreadySatisfied,
	failed,
	succeeded,
} from "../goals.js";

const log = createLogger("goal:tow-wreck");

/** Permanent-precondition prefix the tow-salvage loop watches for to stop instead of retrying. */
export const PERMANENT_PREFIX = "PERMANENT:";

/** Tow a wreck by id. Requires a tow-rig utility module fitted. */
export class TowWreck implements Goal {
	readonly name = "tow-wreck";
	private readonly wreckId: string;

	constructor(wreckId: string) {
		this.wreckId = wreckId;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		log.info(`Towing wreck ${this.wreckId}`);
		try {
			await ctx.endpoints.towWreck(this.wreckId);
			return succeeded(`Towing wreck ${this.wreckId}`, 1);
		} catch (err) {
			if (err instanceof ApiError) {
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
