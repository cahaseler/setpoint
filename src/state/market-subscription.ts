/**
 * Keeps a market subscription alive for every account that has a live
 * `GET /accounts/:playerId/market/events` subscriber.
 *
 * `market_update` only arrives while `subscribeMarket()` is active, and that
 * subscription belongs to the station the ship is docked at: the server drops
 * it silently on undock (`flushMarketSubscriptions`), and the lib mirrors the
 * drop by clearing `marketSubscribed`. Without this keeper a stream would go
 * quiet after the ship's first departure and never recover.
 *
 * Unlike the observation watch, a market subscription cannot exist at all
 * while undocked. So a subscriber attached to a ship in flight is simply held
 * until the ship next docks, rather than refused; the stream emits once there
 * is a station to watch.
 *
 * It only ever subscribes, for the same reason as the observation keeper:
 * nothing distinguishes a subscription it opened from one an operator opened
 * by hand through the raw passthrough.
 */

import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("market-subscription");

/** The account surface this keeper needs — a narrow slice of the lib's `Account`. */
export interface MarketSubscribable {
	get marketSubscribed(): boolean;
	readonly state: { location?: { docked_at?: string | null | undefined } | undefined };
	subscribeMarket(): Promise<unknown>;
}

interface Holders {
	/** Number of live event-stream subscribers for this account. */
	refs: number;
	/** In-flight subscribe, so concurrent triggers issue one call, not N. */
	pending: Promise<void> | undefined;
}

const isDocked = (account: MarketSubscribable): boolean =>
	typeof account.state.location?.docked_at === "string" &&
	account.state.location.docked_at.length > 0;

export class MarketSubscriptionKeeper {
	private readonly byPlayerId = new Map<string, Holders>();

	/**
	 * Registers a stream subscriber and, if the account is docked, ensures the
	 * subscription is live — awaited, so a failure can be surfaced instead of
	 * handing back a stream that will not emit. An undocked account is
	 * registered and subscribed on its next dock. Returns a release function;
	 * releasing drops the reference but leaves the subscription in place.
	 *
	 * Throws whatever `subscribeMarket()` throws while docked. The reference is
	 * dropped before the error propagates, so a failed open leaves no holder.
	 */
	async acquire(playerId: string, account: MarketSubscribable): Promise<() => void> {
		const holders = this.holdersFor(playerId);
		holders.refs++;

		if (isDocked(account)) {
			try {
				await this.subscribeOnce(playerId, account, holders);
			} catch (err) {
				this.release(playerId);
				throw err;
			}
		}

		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.release(playerId);
		};
	}

	/**
	 * Subscribes if the account still has stream subscribers, is docked, and
	 * has no live subscription — call after any state change that could carry
	 * a dock. A no-op for accounts with no market subscriber.
	 *
	 * Failures are logged and left for the next location change to retry.
	 */
	resubscribeIfDropped(playerId: string, account: MarketSubscribable): void {
		const holders = this.byPlayerId.get(playerId);
		if (!holders || holders.refs === 0) return;
		if (account.marketSubscribed || !isDocked(account)) return;

		void this.subscribeOnce(playerId, account, holders).catch((err: unknown) => {
			log.warn(`[${playerId}] market subscription could not be established: ${errorMessage(err)}`);
		});
	}

	/** Whether this account currently has at least one live event-stream subscriber. */
	hasSubscribers(playerId: string): boolean {
		return (this.byPlayerId.get(playerId)?.refs ?? 0) > 0;
	}

	private holdersFor(playerId: string): Holders {
		let holders = this.byPlayerId.get(playerId);
		if (!holders) {
			holders = { refs: 0, pending: undefined };
			this.byPlayerId.set(playerId, holders);
		}
		return holders;
	}

	private subscribeOnce(
		playerId: string,
		account: MarketSubscribable,
		holders: Holders,
	): Promise<void> {
		if (account.marketSubscribed) return Promise.resolve();
		if (holders.pending) return holders.pending;

		const pending = account
			.subscribeMarket()
			.then(() => {
				log.info(
					`[${playerId}] market subscribed at ${account.state.location?.docked_at} for the event stream`,
				);
			})
			.finally(() => {
				if (holders.pending === pending) holders.pending = undefined;
			});

		holders.pending = pending;
		return pending;
	}

	private release(playerId: string): void {
		const holders = this.byPlayerId.get(playerId);
		if (!holders) return;
		holders.refs = Math.max(0, holders.refs - 1);
		if (holders.refs === 0) this.byPlayerId.delete(playerId);
	}
}
