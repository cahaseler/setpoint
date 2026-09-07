import type { GameState } from "@spacemolt/lib";
import { createLogger } from "../util/logger.js";
import type { LibGoalContext } from "./lib-goal-context.js";

const log = createLogger("wait-for-location");

/**
 * How long to poll for a resolved location before giving up. The game's own
 * mid-jump error message quotes an ETA (e.g. "~60s until arrival"), but that's
 * only a snapshot at the moment of the failed attempt — matches the lib's own
 * `mutationTimeoutMs` budget for jump/travel mutations (600s), which is the
 * system's existing assumption for the longest a single transit can take.
 */
export const DEFAULT_MAX_WAIT_MS = 600_000;

/** Delay between polls. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface LocationWaitOptions {
	maxWaitMs?: number;
	pollIntervalMs?: number;
	/**
	 * Read position from the push-fed cache instead of forcing a live
	 * `get_status` on every poll.
	 *
	 * Only safe where the server actually pushes the transition being waited
	 * for. Since game v0.596.2 a fleet follower receives its arrival state
	 * directly, so waiting on a member to arrive no longer needs a query per
	 * poll per ship. A non-forced read still escalates to a live one if the
	 * cache goes stale (see `isStateStale`), so a missed push degrades to
	 * today's behaviour rather than waiting forever.
	 */
	useCache?: boolean;
}

/**
 * Poll (via forced live refreshes) until `predicate` is satisfied or
 * `maxWaitMs` elapses, then return whatever state was last read.
 *
 * The game server reports `location.system_id`/`poi_id` as momentarily
 * unknown while a ship is mid-transit (jump or in-system travel), and its own
 * rejection message for a jump attempted during that window says "wait ~60s
 * and resubmit". Reading position once and immediately failing the goal when
 * it comes back unknown forces exactly that resubmission from the caller —
 * except a fresh submission's own first jump can then race the still-settling
 * transit from the previous one, producing a new one-hop-then-fail instead of
 * progress. Waiting inside the primitive is the fix: same wait the server
 * already told the caller to do, just inside the step instead of outside it.
 */
export async function waitForLocation(
	ctx: LibGoalContext,
	predicate: (state: Readonly<GameState>) => boolean,
	opts: LocationWaitOptions = {},
): Promise<Readonly<GameState>> {
	const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const deadline = Date.now() + maxWaitMs;
	const read = (): Promise<Readonly<GameState>> =>
		opts.useCache === true ? ctx.refreshState() : ctx.refreshState({ force: true });

	let state = await read();
	while (!predicate(state) && !ctx.signal?.aborted && Date.now() < deadline) {
		// Never sleep past the deadline. A full poll interval with only
		// milliseconds of budget left overshoots maxWaitMs by orders of
		// magnitude, which makes a caller's timeout meaningless.
		const wait = Math.min(pollIntervalMs, deadline - Date.now());
		if (wait <= 0) break;
		log.info(`Location unresolved, waiting ${wait / 1000}s before re-checking`);
		await new Promise<void>((resolve) => setTimeout(resolve, wait));
		state = await read();
	}
	return state;
}
