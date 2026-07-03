/** How long the push-fed cache is trusted before a non-forced refreshState escalates to a live read. */
export const STATE_FRESHNESS_TTL_MS = 30_000;

// account object → epoch ms of its last known-fresh state (own-mutation delta, refresh, or connect seed).
const lastFresh = new WeakMap<object, number>();

/** Mark an account's cached state as fresh as of `now`. Called whenever the cache is updated/seeded. */
export function markStateFresh(account: object, now: number = Date.now()): void {
	lastFresh.set(account, now);
}

/** True only if the account has a recorded freshness time AND it is older than ttlMs. Untracked accounts (e.g. test fakes) are treated as fresh. */
export function isStateStale(
	account: object,
	ttlMs: number = STATE_FRESHNESS_TTL_MS,
	now: number = Date.now(),
): boolean {
	const t = lastFresh.get(account);
	return t !== undefined && now - t > ttlMs;
}
