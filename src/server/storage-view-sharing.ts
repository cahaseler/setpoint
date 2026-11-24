import type { QueryResult } from "@spacemolt/lib";
import type { LibManagedAccount } from "../accounts/lib-types.js";

/**
 * One answer per tick for repeated storage views on one account.
 *
 * Since game v0.734.2 the server refuses a storage view with
 * `read_repeat_limited` when the same pilot reads it again within a tick and
 * would get the same data back. Several processes driving one account through
 * the raw passthrough cannot coordinate that among themselves, so setpoint
 * answers the repeat itself, with the answer the game would have given.
 *
 * Views are matched on their exact params, so a different station, bucket or
 * target is always its own read. An identical view already in flight shares
 * that call. A finished view is reused while the account's observed game tick
 * is unchanged, and never for longer than `STORAGE_VIEW_SHARE_MAX_AGE_MS`:
 * setpoint learns the tick only from frames the game sends, and there is no
 * per-tick push, so the age cap bounds a tick that moved unseen.
 *
 * Anything that might have changed storage drops every view held for the
 * account: a change to its state cache (a deposit or withdraw moves cargo or
 * credits) and any raw mutation sent for it (`forgetStorageViews`). A failed
 * view is never kept.
 *
 * Keyed by account object identity, like `hold-state.ts` and
 * `state-freshness.ts`: the lib keeps one instance per account across
 * reconnects.
 */

/** The longest a finished storage view is reused, whatever the tick says. */
export const STORAGE_VIEW_SHARE_MAX_AGE_MS = 10_000;

/** What `shareStorageView` needs of an account. */
export type StorageViewAccount = Pick<LibManagedAccount, "currentTick" | "onStateChange">;

interface SharedView {
	readonly tick: number;
	readonly result: Promise<QueryResult>;
	/** When the read finished; absent while it is in flight. */
	readonly settledAt?: number;
}

const views = new WeakMap<object, Map<string, SharedView>>();
const watched = new WeakSet<object>();

/** The match key for a view's params: the same fields and values, in any order. */
export function storageViewKey(params: Record<string, unknown>): string {
	return JSON.stringify(
		Object.keys(params)
			.sort()
			.map((key) => [key, params[key]]),
	);
}

/** Drop every storage view held for `account`. */
export function forgetStorageViews(account: object): void {
	views.delete(account);
}

function isReusable(view: SharedView, tick: number, now: number): boolean {
	return (
		view.settledAt === undefined ||
		(view.tick === tick && now - view.settledAt < STORAGE_VIEW_SHARE_MAX_AGE_MS)
	);
}

function watch(account: StorageViewAccount): void {
	if (watched.has(account)) return;
	watched.add(account);
	account.onStateChange(() => forgetStorageViews(account));
}

function viewsFor(account: object): Map<string, SharedView> {
	const existing = views.get(account);
	if (existing !== undefined) return existing;
	const created = new Map<string, SharedView>();
	views.set(account, created);
	return created;
}

/**
 * Answer a storage view for `account`, calling `read` only when no identical
 * view is in flight or reusable this tick. `shared` is true when the answer
 * came from an earlier call.
 */
export async function shareStorageView(
	account: StorageViewAccount,
	params: Record<string, unknown>,
	read: () => Promise<QueryResult>,
	now: () => number = Date.now,
): Promise<{ result: QueryResult; shared: boolean }> {
	watch(account);
	const key = storageViewKey(params);
	const tick = account.currentTick ?? 0;
	const byKey = viewsFor(account);
	const existing = byKey.get(key);
	if (existing !== undefined && isReusable(existing, tick, now())) {
		return { result: await existing.result, shared: true };
	}

	const view: SharedView = { tick, result: read() };
	byKey.set(key, view);
	try {
		const result = await view.result;
		if (byKey.get(key) === view) byKey.set(key, { ...view, settledAt: now() });
		return { result, shared: false };
	} catch (err) {
		if (byKey.get(key) === view) byKey.delete(key);
		throw err;
	}
}
