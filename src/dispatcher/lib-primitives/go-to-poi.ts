import { ConnectionClosedError, SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import type { LocationWaitOptions } from "../wait-for-location.js";
import { waitForLocation } from "../wait-for-location.js";

const log = createLogger("goal:go-to-poi");

/**
 * Travel to a specific POI within the current system.
 *
 * Already satisfied if the player is already at the target POI.
 * Prerequisites: must be in a system (location known).
 */
export class LibGoToPoi implements LibGoal {
	readonly name = "go-to-poi";
	private readonly targetPoiId: string;
	private readonly waitOpts: LocationWaitOptions;

	constructor(targetPoiId: string, waitOpts: LocationWaitOptions = {}) {
		this.targetPoiId = targetPoiId;
		this.waitOpts = waitOpts;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		const currentPoiId = ctx.state.location?.poi_id;

		if (currentPoiId === this.targetPoiId) {
			return alreadySatisfied(`Already at POI ${this.targetPoiId}`);
		}

		// If location is unknown, force a live read — the cache may lag (e.g. a
		// prior iteration whose mutation delta carried no location).
		let systemId = ctx.state.location?.system_id;
		if (!systemId) {
			log.info("Location unknown, refreshing state before travel");
			const fresh = await ctx.refreshState({ force: true });
			if (fresh.location?.poi_id === this.targetPoiId) {
				return alreadySatisfied(`Already at POI ${this.targetPoiId}`);
			}
			systemId = fresh.location?.system_id;
		}

		if (!systemId) {
			// Still unknown after a live refresh most commonly means mid-transit
			// (a jump that hasn't settled yet) — wait it out instead of failing,
			// which would just make the caller resubmit and race this same
			// still-settling transit.
			log.info("Current system still unknown — waiting for it to resolve (likely mid-transit)");
			const settled = await waitForLocation(
				ctx,
				(s) => s.location?.system_id !== undefined,
				this.waitOpts,
			);
			if (settled.location?.poi_id === this.targetPoiId) {
				return alreadySatisfied(`Already at POI ${this.targetPoiId}`);
			}
			systemId = settled.location?.system_id;
		}

		if (!systemId) {
			return failed("Cannot travel: current location unknown", 0);
		}

		log.info(`Traveling to POI ${this.targetPoiId}`);
		try {
			await ctx.account.commands.spacemolt.travel({ id: this.targetPoiId });
		} catch (err) {
			// On transient errors, force a live read and retry once — the travel may
			// have been rejected due to a mid-transit state or a dropped connection.
			const isRetriable = err instanceof SpacemoltError || err instanceof ConnectionClosedError;
			if (isRetriable) {
				log.warn(
					`Travel to ${this.targetPoiId} failed (${err instanceof Error ? err.message : String(err)}), refreshing state and retrying once`,
				);
				const fresh = await ctx.refreshState({ force: true });
				if (fresh.location?.poi_id === this.targetPoiId) {
					return alreadySatisfied(`Already at POI ${this.targetPoiId}`);
				}
				// Wrap the retry to return failed() on second failure rather than throwing.
				// GoToPoi must never throw — callers like checkHarvesterForPoi have no
				// try/catch and an unhandled throw rejects the loop promise immediately,
				// bypassing the normal failure/retry cycle in runLibLoop.
				try {
					await ctx.account.commands.spacemolt.travel({ id: this.targetPoiId });
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
