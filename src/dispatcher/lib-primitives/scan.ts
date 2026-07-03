import type { ScanResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:scan");

/**
 * Scan the current area to reveal nearby objects and players.
 *
 * This is always an action — there's no "already satisfied" state for scanning.
 * Prerequisites: should be undocked (in space).
 */
export class LibScan implements LibGoal {
	readonly name = "scan";

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (ctx.state.location?.docked_at) {
			return failed("Cannot scan: must be undocked", 0);
		}

		log.info("Scanning area");
		const response = await ctx.account.commands.spacemolt.scan();
		const scan = response.delta.details as ScanResponse | undefined;

		if (scan?.success) {
			log.info(`Scan revealed: ${scan.revealed_info.join(", ")}`);
			return succeeded(`Scan complete: ${scan.revealed_info.length} info revealed`, 1);
		}

		return failed("Scan failed", 1);
	}
}
