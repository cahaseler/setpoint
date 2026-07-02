import { ApiError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import { type Goal, type GoalContext, type GoalResult, failed, succeeded } from "../goals.js";
import { PERMANENT_PREFIX } from "./tow-wreck.js";

const log = createLogger("goal:dispose-towed-wreck");

export interface DisposeTowedWreckOptions {
	disposition: "scrap" | "sell";
}

/** Scrap (materials) or sell (credits) the currently-towed wreck. Must be docked at a salvage yard. */
export class DisposeTowedWreck implements Goal {
	readonly name = "dispose-towed-wreck";
	private readonly options: DisposeTowedWreckOptions;

	constructor(options: DisposeTowedWreckOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot dispose wreck: must be docked at a salvage yard", 0);
		}

		const { disposition } = this.options;
		log.info(`Disposing towed wreck via ${disposition}`);
		try {
			if (disposition === "scrap") {
				await ctx.endpoints.scrapTowedWreck();
			} else {
				await ctx.endpoints.sellTowedWreck();
			}
			return succeeded(`Wreck ${disposition === "scrap" ? "scrapped" : "sold"}`, 1);
		} catch (err) {
			if (
				err instanceof ApiError &&
				/skill|salvag(e|ing)|no_salvage_yard|not.*yard/i.test(`${err.code} ${err.message}`)
			) {
				return failed(`${PERMANENT_PREFIX} cannot ${disposition} — ${err.message}`, 0);
			}
			throw err;
		}
	}
}
