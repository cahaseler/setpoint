import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";

const log = createLogger("goal:scan");

/**
 * Scan the current area to reveal nearby objects and players.
 *
 * This is always an action — there's no "already satisfied" state for scanning.
 * Prerequisites: should be undocked (in space).
 */
export class Scan implements Goal {
	readonly name = "scan";

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (ctx.state.location?.docked_at) {
			return failed("Cannot scan: must be undocked", 0);
		}

		log.info("Scanning area");
		const response = await ctx.endpoints.scan();
		const scan = response.structuredContent;

		if (scan.success) {
			log.info(`Scan revealed: ${scan.revealed_info.join(", ")}`);
			return succeeded(`Scan complete: ${scan.revealed_info.length} info revealed`, 1);
		}

		return failed("Scan failed", 1);
	}
}
