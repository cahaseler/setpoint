import { SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import type { LocationWaitOptions } from "../wait-for-location.js";
import { waitForLocation } from "../wait-for-location.js";

const log = createLogger("goal:dock-at");

/**
 * Dock at a specific station or base.
 *
 * Already satisfied if the player is already docked at the target.
 * Prerequisites: must be at the POI (same poi_id as target).
 */
export class LibDockAt implements LibGoal {
	readonly name = "dock-at";
	private readonly targetBaseId: string;
	private readonly waitOpts: LocationWaitOptions;

	constructor(targetBaseId: string, waitOpts: LocationWaitOptions = {}) {
		this.targetBaseId = targetBaseId;
		this.waitOpts = waitOpts;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		// docked_at can go stale: the server undocks ships without a mutation
		// response through us (e.g. a mobile base jumping away), so verify
		// against live state before trusting the local snapshot — queries are free.
		let state = await ctx.refreshState();
		let dockedAt = state.location?.docked_at;

		if (dockedAt === this.targetBaseId) {
			// Known limitation: doesn't check in_transit here — docked_at going
			// stale mid-transit is a narrower window than system_id/poi_id (the
			// server has to explicitly undock the ship first), but not impossible.
			return alreadySatisfied(`Already docked at ${this.targetBaseId}`);
		}

		if (!state.location?.poi_id || state.location?.in_transit) {
			// Immediately after arriving (e.g. the go-to-poi step just before this
			// one in a compound sequence) the cache can briefly lag reality, or
			// this may be genuinely mid-transit (in_transit true, even if poi_id
			// still reads as the stale pre-departure value) — wait for it to
			// resolve instead of failing outright, which would just make the
			// caller resubmit and race the same still-settling arrival.
			log.info("Not at a POI, unknown, or mid-transit — waiting for location to resolve");
			state = await waitForLocation(
				ctx,
				(s) => s.location?.poi_id !== undefined && !s.location.in_transit,
				this.waitOpts,
			);
			dockedAt = state.location?.docked_at;
			if (dockedAt === this.targetBaseId) {
				return alreadySatisfied(`Already docked at ${this.targetBaseId}`);
			}
		}

		if (!state.location?.poi_id || state.location?.in_transit) {
			return failed("Cannot dock: not at a POI or still mid-transit", 0);
		}

		log.info(`Docking at ${this.targetBaseId}`);
		try {
			await ctx.account.commands.spacemolt.dock();
		} catch (err) {
			if (err instanceof SpacemoltError && err.code === "already_docked") {
				return alreadySatisfied("Already docked");
			}
			if (err instanceof SpacemoltError && err.code === "mutation_timeout") {
				// The ack means this dock WAS queued — only its outcome frame
				// arrived too late (or not at all) to match the mutate() call
				// still awaiting it. A live re-check can reveal the dock actually
				// landed before this attempt is written off as a failure.
				const refreshed = await ctx.refreshState({ force: true });
				if (refreshed.location?.docked_at === this.targetBaseId) {
					log.info(
						`Dock timed out but docked_at now matches ${this.targetBaseId} — treating as success`,
					);
					return succeeded(`Docked at ${this.targetBaseId}`, 1);
				}
			}
			throw err;
		}

		return succeeded(`Docked at ${this.targetBaseId}`, 1);
	}
}
