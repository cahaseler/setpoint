import type { NotificationHoldUpdate } from "@spacemolt/lib";

/**
 * Warp-scrambler holds on the accounts setpoint drives, fed by the server's
 * `hold_update` push. A hold is not part of the game state, so this push is
 * the only way to know one is in force. While held, a ship's jump and travel
 * wait and its dock is refused.
 *
 * Keyed by account object identity, like `state-freshness.ts`: the lib keeps
 * one instance per account across reconnects, and goals reach it as
 * `ctx.account` with no player id in hand.
 */

export type HoldSource = NotificationHoldUpdate["source"];

export interface ActiveHold {
	source: HoldSource;
	holderName: string;
	startTick: number;
}

/**
 * How long to wait for a customs hold to end before trying again anyway. The
 * game holds a ship for at most 3 ticks for a customs inspection; this allows
 * 4 ticks of 10s plus slack, for a hold whose start or end push was missed.
 */
export const CUSTOMS_HOLD_MAX_WAIT_MS = 45_000;

const holds = new WeakMap<object, ActiveHold>();
const endWaiters = new WeakMap<object, Set<() => void>>();

/** Record a `hold_update` in which `account` is the held pilot. */
export function recordHoldUpdate(account: object, update: NotificationHoldUpdate): void {
	if (update.event === "started") {
		holds.set(account, {
			source: update.source,
			holderName: update.holder_name,
			startTick: update.start_tick,
		});
		return;
	}
	holds.delete(account);
	const waiters = endWaiters.get(account);
	endWaiters.delete(account);
	for (const wake of waiters ?? []) wake();
}

/**
 * Drop the recorded hold without an end push. For a customs hold that has
 * outlived the longest an inspection can last: its end push was missed, and
 * the stale record would otherwise stall every later dock.
 */
export function forgetHold(account: object): void {
	holds.delete(account);
}

/** The hold `account` is under, if any. */
export function activeHold(account: object): ActiveHold | undefined {
	return holds.get(account);
}

/**
 * Resolve when the next `hold_update` ended push for `account` arrives, or
 * after `maxWaitMs`, or on abort. Returns true only when the end was seen.
 *
 * It waits for the next end even if no hold is recorded, because a refusal
 * can reach a goal before the hold's start push does.
 */
export function waitForHoldEnd(
	account: object,
	{
		maxWaitMs = CUSTOMS_HOLD_MAX_WAIT_MS,
		signal,
	}: { maxWaitMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const waiters = endWaiters.get(account) ?? new Set<() => void>();
		endWaiters.set(account, waiters);
		const finish = (ended: boolean): void => {
			clearTimeout(timer);
			waiters.delete(wake);
			signal?.removeEventListener("abort", onAbort);
			resolve(ended);
		};
		const wake = (): void => finish(true);
		const onAbort = (): void => finish(false);
		const timer = setTimeout(() => finish(false), maxWaitMs);
		waiters.add(wake);
		if (signal?.aborted) {
			finish(false);
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
