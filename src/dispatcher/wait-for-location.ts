import type { GameState } from "@spacemolt/lib";
import { createLogger } from "../util/logger.js";
import type { LibGoalContext } from "./lib-goal-context.js";

const log = createLogger("wait-for-location");

/** How long to poll for a resolved location before giving up. The game's own mid-jump error message quotes ~60s until arrival. */
const DEFAULT_MAX_WAIT_MS = 90_000;

/** Delay between polls. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface LocationWaitOptions {
	maxWaitMs?: number;
	pollIntervalMs?: number;
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

	let state = await ctx.refreshState({ force: true });
	while (!predicate(state) && !ctx.signal?.aborted && Date.now() < deadline) {
		log.info(`Location unresolved, waiting ${pollIntervalMs / 1000}s before re-checking`);
		await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
		state = await ctx.refreshState({ force: true });
	}
	return state;
}
