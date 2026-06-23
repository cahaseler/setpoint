import { ApiError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:ensure-repaired");

/**
 * Ensure the ship hull is fully repaired.
 *
 * Already satisfied if current hull equals max hull.
 * Prerequisites: must be docked at a station.
 */
export class EnsureRepaired implements Goal {
	readonly name = "ensure-repaired";

	async execute(ctx: GoalContext): Promise<GoalResult> {
		const currentHull = ctx.state.ship?.hull;
		const maxHull = ctx.state.ship?.max_hull;

		if (currentHull === undefined || maxHull === undefined) {
			return failed("Cannot repair: ship state unknown", 0);
		}

		if (currentHull >= maxHull) {
			return alreadySatisfied(`Hull already at ${currentHull}/${maxHull}`);
		}

		if (!ctx.state.location?.docked_at) {
			return failed("Cannot repair: must be docked at a station", 0);
		}

		const damage = maxHull - currentHull;
		log.info(`Repairing hull: ${currentHull}/${maxHull} (${damage} damage)`);
		try {
			await ctx.endpoints.repair();
		} catch (err) {
			if (err instanceof ApiError && err.code === "hull_full") {
				return alreadySatisfied("Hull already full");
			}
			throw err;
		}

		return succeeded(`Repaired ${damage} hull damage`, 1);
	}
}
