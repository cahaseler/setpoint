import { ApiError, HttpError } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:go-to-poi");

/**
 * Travel to a specific POI within the current system.
 *
 * Already satisfied if the player is already at the target POI.
 * Prerequisites: must be in a system (location known).
 */
export class GoToPoi implements Goal {
	readonly name = "go-to-poi";
	private readonly targetPoiId: string;

	constructor(targetPoiId: string) {
		this.targetPoiId = targetPoiId;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		const currentPoiId = ctx.state.location?.poi_id;

		if (currentPoiId === this.targetPoiId) {
			return alreadySatisfied(`Already at POI ${this.targetPoiId}`);
		}

		// If location is unknown, try refreshing — the state snapshot may be stale
		// (e.g., from a previous iteration where no mutation updated location).
		let systemId = ctx.state.location?.system_id;
		if (!systemId && ctx.refreshState) {
			log.info("Location unknown, refreshing state before travel");
			const fresh = await ctx.refreshState();
			if (fresh.location?.poi_id === this.targetPoiId) {
				return alreadySatisfied(`Already at POI ${this.targetPoiId}`);
			}
			systemId = fresh.location?.system_id;
		}

		if (!systemId) {
			return failed("Cannot travel: current location unknown", 0);
		}

		log.info(`Traveling to POI ${this.targetPoiId}`);
		try {
			await ctx.endpoints.travel(this.targetPoiId);
		} catch (err) {
			// On transient API errors, refresh state and retry once — the travel
			// may have been rejected due to a mid-transit state or server hiccup.
			const isRetriable =
				err instanceof ApiError ||
				(err instanceof HttpError && (err.statusCode === 0 || err.statusCode >= 500));
			if (isRetriable && ctx.refreshState) {
				log.warn(
					`Travel to ${this.targetPoiId} failed (${err instanceof Error ? err.message : String(err)}), refreshing state and retrying once`,
				);
				const fresh = await ctx.refreshState();
				if (fresh.location?.poi_id === this.targetPoiId) {
					return alreadySatisfied(`Already at POI ${this.targetPoiId}`);
				}
				// Wrap the retry to return failed() on second failure rather than throwing.
				// GoToPoi must never throw — callers like checkHarvesterForPoi have no
				// try/catch and an unhandled throw rejects the loop promise immediately,
				// bypassing the normal 10-failure retry cycle in runLoop.
				try {
					await ctx.endpoints.travel(this.targetPoiId);
				} catch (retryErr) {
					const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
					log.warn(`Travel to ${this.targetPoiId} failed on retry: ${msg}`);
					return failed(`Travel to ${this.targetPoiId} failed: ${msg}`, 0);
				}
			} else {
				throw err;
			}
		}

		return succeeded(`Traveled to POI ${this.targetPoiId}`, 1);
	}
}
