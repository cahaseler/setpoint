/**
 * Keeps an observation watch alive for every account that has a live
 * `GET /accounts/:playerId/observation/events` subscriber.
 *
 * The observation feed is the one push stream setpoint relays that the game
 * server does not send unprompted: `observation_update` only arrives while
 * `subscribeObservation()` is active, and the server silently drops that
 * subscription the instant the ship leaves the watched POI
 * (`internal/game/observation_subscriptions.go` — the lib mirrors the drop by
 * clearing `observationSubscribed`). Without this keeper an event stream would
 * open, work, and then go permanently quiet on the first jump, which is
 * indistinguishable from "nothing is happening at this POI" — the exact
 * failure a change feed exists to rule out.
 *
 * It only ever subscribes. Tearing a watch down on the last stream close would
 * also tear down one an operator established by hand through the raw
 * passthrough, and nothing distinguishes the two; unsubscribing stays an
 * explicit caller action.
 */

import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("observation-subscription");

/** The account surface this keeper needs — a narrow slice of the lib's `Account`. */
export interface ObservationSubscribable {
	get observationSubscribed(): boolean;
	/** The `activeScan` flag the live watch was subscribed with, if any. */
	get observationActiveScan(): boolean;
	subscribeObservation(activeScan?: boolean): Promise<unknown>;
}

interface Holders {
	/** Number of live event-stream subscribers for this account. */
	refs: number;
	/** Number of those subscribers that asked for an active sensor sweep. */
	activeScanRefs: number;
	/** In-flight subscribe, so concurrent stream opens issue one call, not N. */
	pending: Promise<void> | undefined;
}

export class ObservationSubscriptionKeeper {
	private readonly byPlayerId = new Map<string, Holders>();

	/**
	 * Registers a stream subscriber and ensures the watch is live, awaiting the
	 * subscribe so the caller can surface a failure instead of handing back a
	 * stream that will never emit. Returns a release function; releasing drops
	 * the reference but leaves the watch subscribed.
	 *
	 * Throws whatever `subscribeObservation()` throws (most often because the
	 * ship is somewhere a watch can't be established). The reference is dropped
	 * again before the error propagates, so a failed open leaves no phantom
	 * holder behind.
	 */
	async acquire(
		playerId: string,
		account: ObservationSubscribable,
		activeScan: boolean,
	): Promise<() => void> {
		const holders = this.holdersFor(playerId);
		holders.refs++;
		if (activeScan) holders.activeScanRefs++;

		try {
			await this.subscribeOnce(playerId, account, holders);
		} catch (err) {
			this.release(playerId, activeScan);
			throw err;
		}

		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.release(playerId, activeScan);
		};
	}

	/**
	 * Re-establishes the watch if the account still has stream subscribers and
	 * the server dropped it — call after any state change that could carry a
	 * location move. A no-op for the overwhelming majority of accounts, which
	 * have no observation subscriber at all.
	 *
	 * Failures are logged and left for the next location change to retry: a
	 * ship mid-jump has no POI to watch, and the arrival will call back here.
	 */
	resubscribeIfDropped(playerId: string, account: ObservationSubscribable): void {
		const holders = this.byPlayerId.get(playerId);
		if (!holders || holders.refs === 0) return;
		if (account.observationSubscribed) return;

		void this.subscribeOnce(playerId, account, holders).catch((err: unknown) => {
			log.warn(
				`[${playerId}] observation watch dropped and could not be re-established: ${errorMessage(err)}`,
			);
		});
	}

	/** Whether this account currently has at least one live event-stream subscriber. */
	hasSubscribers(playerId: string): boolean {
		return (this.byPlayerId.get(playerId)?.refs ?? 0) > 0;
	}

	private holdersFor(playerId: string): Holders {
		let holders = this.byPlayerId.get(playerId);
		if (!holders) {
			holders = { refs: 0, activeScanRefs: 0, pending: undefined };
			this.byPlayerId.set(playerId, holders);
		}
		return holders;
	}

	/**
	 * Subscribes unless the watch is already live, collapsing concurrent calls
	 * onto one in-flight request. A watch established without an active sweep
	 * is re-subscribed when a later subscriber asks for one, since the flag is
	 * fixed at subscribe time.
	 */
	private subscribeOnce(
		playerId: string,
		account: ObservationSubscribable,
		holders: Holders,
	): Promise<void> {
		const wantActiveScan = holders.activeScanRefs > 0;
		// An already-active sweep satisfies a subscriber that didn't ask for one,
		// so only escalation (no sweep running, one wanted) forces a resubscribe.
		// Downgrading would fight any subscriber that does want it.
		if (account.observationSubscribed && (!wantActiveScan || account.observationActiveScan)) {
			return Promise.resolve();
		}
		if (holders.pending) return holders.pending;

		const pending = account
			.subscribeObservation(wantActiveScan)
			.then(() => {
				log.info(
					`[${playerId}] observation watch subscribed (activeScan=${wantActiveScan}) for the event stream`,
				);
			})
			.finally(() => {
				if (holders.pending === pending) holders.pending = undefined;
			});

		holders.pending = pending;
		return pending;
	}

	private release(playerId: string, activeScan: boolean): void {
		const holders = this.byPlayerId.get(playerId);
		if (!holders) return;
		holders.refs = Math.max(0, holders.refs - 1);
		if (activeScan) holders.activeScanRefs = Math.max(0, holders.activeScanRefs - 1);
		if (holders.refs === 0) this.byPlayerId.delete(playerId);
	}
}
