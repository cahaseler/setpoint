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

		if (currentPoiId === this.targetPoiId && !ctx.state.location?.in_transit) {
			return alreadySatisfied(`Already at POI ${this.targetPoiId}`);
		}

		// If location is unknown or mid-transit, force a live read — the cache may
		// lag (e.g. a prior iteration whose mutation delta carried no location), or
		// a jump/travel from a previous step may still be in flight.
		let systemId = ctx.state.location?.system_id;
		let inTransit = ctx.state.location?.in_transit;
		if (!systemId || inTransit) {
			log.info("Location unknown or mid-transit, refreshing state before travel");
			const fresh = await ctx.refreshState({ force: true });
			if (fresh.location?.poi_id === this.targetPoiId && !fresh.location?.in_transit) {
				return alreadySatisfied(`Already at POI ${this.targetPoiId}`);
			}
			systemId = fresh.location?.system_id;
			inTransit = fresh.location?.in_transit;
		}

		if (!systemId || inTransit) {
			// Still unknown/mid-transit after a live refresh most commonly means a
			// jump hasn't settled yet — wait it out instead of failing, which would
			// just make the caller resubmit and race this same still-settling
			// transit. Checking in_transit explicitly (not just an unknown
			// system_id) covers a ship that still reports its stale pre-jump system.
			log.info("Current system still unknown or mid-transit — waiting for it to resolve");
			const settled = await waitForLocation(
				ctx,
				(s) => s.location?.system_id !== undefined && !s.location.in_transit,
				this.waitOpts,
			);
			if (settled.location?.poi_id === this.targetPoiId && !settled.location?.in_transit) {
				return alreadySatisfied(`Already at POI ${this.targetPoiId}`);
			}
			systemId = settled.location?.system_id;
			inTransit = settled.location?.in_transit;
		}

		if (!systemId || inTransit) {
			return failed("Cannot travel: current location unknown or still mid-transit", 0);
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
					`Travel to ${this.targetPoiId} failed (${err instanceof Error ? err.message : String(err)}), refreshing state before retrying once`,
				);
				let fresh = await ctx.refreshState({ force: true });
				if (fresh.location?.poi_id === this.targetPoiId && !fresh.location?.in_transit) {
					return alreadySatisfied(`Already at POI ${this.targetPoiId}`);
				}
				if (fresh.location?.in_transit) {
					// The rejection is very often the server itself saying "you're
					// mid-travel, wait ~Ns and resubmit" — an immediate retry just
					// collides with that same still-executing transit again. Wait it
					// out first instead of re-issuing the mutation right away.
					log.info("Mid-transit after travel failure — waiting for it to resolve");
					fresh = await waitForLocation(
						ctx,
						(s) => s.location?.poi_id !== undefined && !s.location.in_transit,
						this.waitOpts,
					);
					if (fresh.location?.poi_id === this.targetPoiId && !fresh.location?.in_transit) {
						return alreadySatisfied(`Already at POI ${this.targetPoiId}`);
					}
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
