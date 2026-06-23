import { ApiError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:dock-at");

/**
 * Dock at a specific station or base.
 *
 * Already satisfied if the player is already docked at the target.
 * Prerequisites: must be at the POI (same poi_id as target).
 */
export class DockAt implements Goal {
	readonly name = "dock-at";
	private readonly targetBaseId: string;

	constructor(targetBaseId: string) {
		this.targetBaseId = targetBaseId;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		// docked_at can go stale: the server undocks ships without a mutation
		// response through us (e.g. a mobile base jumping away), so verify
		// against live state before trusting the local snapshot — queries are free.
		const state = ctx.refreshState ? await ctx.refreshState() : ctx.state;
		const dockedAt = state.location?.docked_at;

		if (dockedAt === this.targetBaseId) {
			return alreadySatisfied(`Already docked at ${this.targetBaseId}`);
		}

		if (!state.location?.poi_id) {
			return failed("Cannot dock: not at a POI", 0);
		}

		log.info(`Docking at ${this.targetBaseId}`);
		try {
			await ctx.endpoints.dock(this.targetBaseId);
		} catch (err) {
			if (err instanceof ApiError && err.code === "already_docked") {
				return alreadySatisfied("Already docked");
			}
			throw err;
		}

		return succeeded(`Docked at ${this.targetBaseId}`, 1);
	}
}
