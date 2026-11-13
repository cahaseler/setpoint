import { SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import { CUSTOMS_HOLD_MAX_WAIT_MS, activeHold, forgetHold, waitForHoldEnd } from "../hold-state.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import type { LocationWaitOptions } from "../wait-for-location.js";
import { waitForLocation } from "../wait-for-location.js";

const log = createLogger("goal:dock-at");

/**
 * Dock at a specific station or base.
 *
 * Already satisfied if the player is already docked at the target.
 * Prerequisites: must be at the POI (same poi_id as target).
 *
 * A customs inspection holds the ship for up to 3 ticks and refuses its dock
 * meanwhile. The goal waits the inspection out and docks after it, rather
 * than failing on a refusal that clears itself.
 */
export class LibDockAt implements LibGoal {
	readonly name = "dock-at";
	private readonly targetBaseId: string;
	private readonly waitOpts: LocationWaitOptions;
	private readonly customsWaitMs: number;

	constructor(
		targetBaseId: string,
		waitOpts: LocationWaitOptions = {},
		customsWaitMs: number = CUSTOMS_HOLD_MAX_WAIT_MS,
	) {
		this.targetBaseId = targetBaseId;
		this.waitOpts = waitOpts;
		this.customsWaitMs = customsWaitMs;
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
		for (let attempt = 1; ; attempt++) {
			const hold = activeHold(ctx.account);
			if (hold?.source === "customs") {
				log.warn(
					`Held by ${hold.holderName} for a customs inspection since tick ${hold.startTick} — waiting for it to end before docking`,
				);
				await this.waitOutCustoms(ctx);
			}
			try {
				await ctx.account.commands.spacemolt.dock();
				return succeeded(`Docked at ${this.targetBaseId}`, 1);
			} catch (err) {
				if (attempt < MAX_CUSTOMS_DOCK_ATTEMPTS && isCustomsRefusal(ctx, err)) {
					log.warn(
						`Dock refused during a customs inspection (code ${err instanceof SpacemoltError ? err.code : "?"}) — waiting for it to end, then docking again`,
					);
					// Only wait here when no hold is recorded yet: a recorded one is
					// waited out at the top of the next attempt.
					if (activeHold(ctx.account) === undefined) await this.waitOutCustoms(ctx);
					continue;
				}
				return this.handleDockError(ctx, err);
			}
		}
	}

	private async waitOutCustoms(ctx: LibGoalContext): Promise<void> {
		const ended = await waitForHoldEnd(ctx.account, {
			maxWaitMs: this.customsWaitMs,
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
		if (ctx.signal?.aborted) throw new Error(`Docking at ${this.targetBaseId} aborted`);
		if (!ended) forgetHold(ctx.account);
		log.info(
			ended
				? "Customs inspection ended — docking"
				: "No end of the customs inspection seen within the wait — trying to dock anyway",
		);
	}

	private async handleDockError(ctx: LibGoalContext, err: unknown): Promise<GoalResult> {
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
}

/**
 * Dock attempts allowed while customs keeps refusing. One hold is at most 3
 * ticks, so a third refusal means something other than one inspection.
 */
const MAX_CUSTOMS_DOCK_ATTEMPTS = 3;

/**
 * True when a dock failure was a customs hold's refusal. The game gives the
 * refusal no documented code, so it is recognised by the recorded hold, or
 * by the wording when the refusal arrives before the hold's start push.
 */
function isCustomsRefusal(ctx: LibGoalContext, err: unknown): boolean {
	if (!(err instanceof SpacemoltError)) return false;
	return activeHold(ctx.account)?.source === "customs" || /customs inspection/i.test(err.message);
}
