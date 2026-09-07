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

/**
 * How often cache mode still takes a live read, so a dropped push is caught
 * within one window instead of costing the whole wait.
 */
export const CACHE_MODE_LIVE_READ_MS = 30_000;

export interface LocationWaitOptions {
	maxWaitMs?: number;
	pollIntervalMs?: number;
	/**
	 * Read position from the push-fed cache between periodic live reads, rather
	 * than forcing a `get_status` on every poll.
	 *
	 * Safe only where the server actually pushes the transition being waited
	 * for. Since game v0.596.2 a fleet follower receives its arrival state
	 * directly, so waiting on a member no longer needs a query per poll per
	 * ship.
	 *
	 * A live read is still forced every `CACHE_MODE_LIVE_READ_MS`, and that
	 * backstop is not optional: `isStateStale` cannot serve as one here,
	 * because `markStateFresh` is called on EVERY state-section change — a
	 * cargo delta or hull damage resets the freshness clock while `location`
	 * stays wrong. Relying on it would let a dropped location push go unseen
	 * for the whole wait and report `did_not_arrive` for a ship that arrived.
	 */
	useCache?: boolean;
	/** How often cache mode still takes a live read. Defaults to `CACHE_MODE_LIVE_READ_MS`. */
	liveReadIntervalMs?: number;
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
	let lastLiveRead = Date.now();
	const read = (): Promise<Readonly<GameState>> => {
		if (opts.useCache !== true) return ctx.refreshState({ force: true });
		if (Date.now() - lastLiveRead >= (opts.liveReadIntervalMs ?? CACHE_MODE_LIVE_READ_MS)) {
			lastLiveRead = Date.now();
			return ctx.refreshState({ force: true });
		}
		return ctx.refreshState();
	};

	// The first read is always live: it establishes the baseline the cached
	// polls are trusted against.
	let state = await ctx.refreshState({ force: true });
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
