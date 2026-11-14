import { SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../util/logger.js";
import { CUSTOMS_HOLD_MAX_WAIT_MS, activeHold, forgetHold, waitForHoldEnd } from "./hold-state.js";
import type { LibGoalContext } from "./lib-goal-context.js";

const log = createLogger("customs-hold");

/**
 * Attempts allowed while customs keeps refusing. One inspection holds a ship
 * for at most 3 ticks, so a third refusal means something other than one
 * inspection, and the refusal is passed to the caller.
 */
const MAX_CUSTOMS_ATTEMPTS = 3;

/**
 * Send a movement mutation (jump, travel, dock) so that a customs inspection
 * delays it instead of failing it.
 *
 * A customs checkpoint can hold a ship for up to 3 ticks. If a hold is already
 * recorded, this waits for it to end before sending. If the game refuses the
 * mutation because of a hold this module had not yet seen (the refusal can
 * arrive before the hold's start push), it waits for the end and sends again.
 * Anything else the mutation throws is passed straight through.
 */
export async function sendThroughCustoms<T>(
	ctx: LibGoalContext,
	action: string,
	send: () => Promise<T>,
	{ maxWaitMs = CUSTOMS_HOLD_MAX_WAIT_MS }: { maxWaitMs?: number } = {},
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		const hold = activeHold(ctx.account);
		if (hold?.source === "customs") {
			log.warn(
				`Held by ${hold.holderName} for a customs inspection since tick ${hold.startTick} — waiting for it to end before ${action}`,
			);
			await waitOutCustoms(ctx, action, maxWaitMs);
		}
		try {
			return await send();
		} catch (err) {
			if (attempt >= MAX_CUSTOMS_ATTEMPTS || !isCustomsRefusal(ctx, err)) throw err;
			log.warn(
				`${action} refused during a customs inspection (code ${err instanceof SpacemoltError ? err.code : "?"}) — waiting for it to end, then trying again`,
			);
			// A recorded hold is waited out at the top of the next attempt.
			if (activeHold(ctx.account) === undefined) await waitOutCustoms(ctx, action, maxWaitMs);
		}
	}
}

async function waitOutCustoms(
	ctx: LibGoalContext,
	action: string,
	maxWaitMs: number,
): Promise<void> {
	const ended = await waitForHoldEnd(ctx.account, {
		maxWaitMs,
		...(ctx.signal ? { signal: ctx.signal } : {}),
	});
	if (ctx.signal?.aborted) throw new Error(`${action} aborted during a customs inspection`);
	// A hold that outlived the longest inspection had its end push missed; the
	// stale record would otherwise stall every later movement.
	if (!ended) forgetHold(ctx.account);
	log.info(
		ended
			? `Customs inspection ended — ${action}`
			: `No end of the customs inspection seen within ${maxWaitMs / 1000}s — trying ${action} anyway`,
	);
}

/**
 * True when a failure was a customs hold's refusal. The game gives the
 * refusal no documented code, so it is recognised by the recorded hold, or by
 * the wording when the refusal arrives before the hold's start push.
 */
function isCustomsRefusal(ctx: LibGoalContext, err: unknown): boolean {
	if (!(err instanceof SpacemoltError)) return false;
	return activeHold(ctx.account)?.source === "customs" || /customs inspection/i.test(err.message);
}
