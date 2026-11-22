/**
 * Holds game calls back while the game has told us to stop.
 *
 * Two signals, at two scopes:
 *
 * - **An account was rate-limited.** The lib retries the throttled call by
 *   itself after the server's wait, but until now every other call on that
 *   account kept going out and collected its own `rate_limited` — and every
 *   one of those counts toward the game's per-IP violation limit. New calls on
 *   that account now wait out the same window.
 * - **The IP was blocked.** The game answers every call from the box with
 *   "Your IP has been temporarily blocked due to excessive rate limit
 *   violations. Try again in N seconds." The lib does not recognise it, so
 *   nothing stopped calls from piling into the block: on 2026-10-24 about 140
 *   went in during one 120-second block. Every account's new calls now wait
 *   until it lifts, plus a margin.
 *
 * Both holds are applied to every frame the lib sends, through its
 * `scheduleSend` hook (see `scheduleSend`): calls, the lib's own automatic
 * retry of a throttled call, and the authentication of a reconnect. Each of
 * those is a request the game counts, so a hold that let any of them through
 * would still be adding to the IP's violation count during a block.
 *
 * Two things stay on the account's `query` and `mutate`, wrapped in place (see
 * `install`) so the instance keeps its identity, which `state-freshness.ts`
 * keys on: recognising an IP block from a failed call, and waiting out a
 * reconnect. The lib refuses to send at all while an account is reconnecting,
 * so that wait has to happen before the call reaches it.
 */

import type { SendAdmissionRequest } from "@spacemolt/lib";

import { createLogger } from "../util/logger.js";

const log = createLogger("game-call-gate");

/**
 * The block notice carries no documented error code — neither the game's spec
 * nor the lib names one — so it is recognised by its wording. The wait is read
 * from the message when present.
 */
const IP_BLOCK_PATTERN = /IP has been temporarily blocked/i;
const IP_BLOCK_SECONDS_PATTERN = /try again in (\d+)\s*seconds?/i;
const DEFAULT_IP_BLOCK_MS = 120_000;
/** Added to the server's stated block, so the first call after it does not race the unblock. */
const IP_BLOCK_MARGIN_MS = 5_000;

/** How long an IP block the error describes lasts, or `undefined` if it is not one. */
export function ipBlockDurationMs(err: unknown): number | undefined {
	const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
	if (!IP_BLOCK_PATTERN.test(message)) return undefined;
	const seconds = IP_BLOCK_SECONDS_PATTERN.exec(message)?.[1];
	return seconds !== undefined ? Number(seconds) * 1000 : DEFAULT_IP_BLOCK_MS;
}

/** The two methods every game call passes through, and whether the socket is up. */
export interface GatedAccount {
	/** The id the lib manages the account under; send requests carry it as `accountId`. */
	readonly id?: string | undefined;
	query: (...args: never[]) => Promise<unknown>;
	mutate: (...args: never[]) => Promise<unknown>;
	/** False while the account is reconnecting. Absent on test doubles that never disconnect. */
	readonly authenticated?: boolean;
}

/**
 * How long a call waits for its account to reconnect before going out anyway
 * (and failing as it would have). A game deploy is over in a few minutes; an
 * account still down after this is not coming back on its own.
 */
const RECONNECT_HOLD_MS = 5 * 60_000;
const RECONNECT_POLL_MS = 500;

/**
 * How often, and for how long, to re-read an account whose queued action the
 * previous setpoint left behind at a handover. The game runs a queued action
 * on the next 10s tick; a jump can stay queued for its whole transit, so the
 * cap allows several ticks before letting commands go out regardless.
 */
const INHERITED_ACTION_POLL_MS = 2_000;
const INHERITED_ACTION_MAX_WAIT_MS = 30_000;

interface QueueView {
	queue?: { has_pending: boolean } | undefined;
}

/** What the gate needs to watch an account's action queue drain. */
export interface DrainableAccount {
	/** The cached state; read once the handover re-read has refreshed it. */
	readonly state: Readonly<QueueView>;
	refresh(): Promise<Readonly<QueueView>>;
}

export interface GameCallGateOptions {
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	reconnectHoldMs?: number;
	inheritedActionMaxWaitMs?: number;
}

export class GameCallGate {
	private ipBlockedUntil = 0;
	private readonly accountHoldUntil = new Map<string, number>();
	/** Lib account id → player id, for the send requests, which carry only the former. */
	private readonly playerIdByAccountId = new Map<string, string>();
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly reconnectHoldMs: number;
	private readonly inheritedActionMaxWaitMs: number;
	/** Accounts whose mutations are held after a handover, and what releases each. */
	private readonly handoverHolds = new Map<string, Promise<void>>();

	constructor({
		now = Date.now,
		sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
		reconnectHoldMs = RECONNECT_HOLD_MS,
		inheritedActionMaxWaitMs = INHERITED_ACTION_MAX_WAIT_MS,
	}: GameCallGateOptions = {}) {
		this.now = now;
		this.sleep = sleep;
		this.reconnectHoldMs = reconnectHoldMs;
		this.inheritedActionMaxWaitMs = inheritedActionMaxWaitMs;
	}

	/**
	 * After a handover, hold this account's mutations until it is known to have
	 * no action the previous setpoint left queued.
	 *
	 * The outgoing daemon may have queued a command for the next tick just
	 * before it stopped. The lib only serializes mutations within one
	 * connection, so the new daemon's next mutation on that account, from a
	 * resumed loop or job or from a caller, would be refused with
	 * `action_pending`. The hold is armed when the new daemon starts serving,
	 * and lasts until `reread` resolves (the handover re-read of this account).
	 * If the re-read shows an action queued, it then lasts until a later re-read
	 * shows the queue empty. Queries are not held.
	 */
	holdAfterHandover(playerId: string, account: DrainableAccount, reread: Promise<void>): void {
		if (this.handoverHolds.has(playerId)) return;
		const released = reread
			.then(() => {
				if (account.state.queue?.has_pending !== true) return;
				log.info(
					`[${playerId}] The previous setpoint left an action queued; holding this account's commands until it has run`,
				);
				return this.drainInheritedAction(playerId, account);
			})
			.finally(() => this.handoverHolds.delete(playerId));
		this.handoverHolds.set(playerId, released);
	}

	/** True while this account's mutations are held after a handover. */
	isHeldAfterHandover(playerId: string): boolean {
		return this.handoverHolds.has(playerId);
	}

	private async drainInheritedAction(playerId: string, account: DrainableAccount): Promise<void> {
		const deadline = this.now() + this.inheritedActionMaxWaitMs;
		while (this.now() < deadline) {
			await this.sleep(INHERITED_ACTION_POLL_MS);
			try {
				const state = await account.refresh();
				if (state.queue?.has_pending !== true) {
					log.info(
						`[${playerId}] Inherited queued action has run; releasing this account's commands`,
					);
					return;
				}
			} catch (err) {
				log.warn(
					`[${playerId}] Re-reading an account with an inherited queued action failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		log.warn(
			`[${playerId}] Inherited queued action still pending after ${this.inheritedActionMaxWaitMs / 1000}s; releasing this account's commands anyway`,
		);
	}

	/** Milliseconds until the current IP block lifts; 0 when there is none. */
	ipBlockRemainingMs(): number {
		return Math.max(0, this.ipBlockedUntil - this.now());
	}

	/**
	 * Record that the game rate-limited a call on this account and will accept
	 * it again in `delayMs`. New calls on the account wait until then.
	 */
	noteRateLimited(playerId: string, delayMs: number): void {
		const until = this.now() + delayMs;
		if (until > (this.accountHoldUntil.get(playerId) ?? 0)) {
			this.accountHoldUntil.set(playerId, until);
		}
	}

	/** Inspect a failed call; an IP block holds every account's new calls. */
	noteFailure(err: unknown): void {
		const blockMs = ipBlockDurationMs(err);
		if (blockMs === undefined) return;
		const until = this.now() + blockMs + IP_BLOCK_MARGIN_MS;
		if (until <= this.ipBlockedUntil) return;
		const fresh = this.ipBlockRemainingMs() === 0;
		this.ipBlockedUntil = until;
		if (fresh) {
			log.warn(
				`Game blocked this IP for excessive rate-limit violations; holding every game call for ${Math.round((blockMs + IP_BLOCK_MARGIN_MS) / 1000)}s, until ${new Date(until).toISOString()}`,
			);
		}
	}

	/**
	 * Hold a call while its account is reconnecting, instead of letting it fail
	 * at once on a closed socket.
	 *
	 * When the game restarts for a deploy, every socket drops and the lib
	 * reconnects each account over a few minutes. Calls made in that window
	 * used to fail immediately, so a loop retrying every 30 seconds burned its
	 * failure budget before its account came back — 18 loops hit 10/10 that
	 * way after one game deploy. Waiting turns the deploy into a pause. A call
	 * that was already in flight when the socket dropped still fails; only new
	 * ones wait.
	 */
	private async waitForConnection(playerId: string, account: GatedAccount): Promise<void> {
		if (account.authenticated !== false) return;
		log.info(`[${playerId}] Account is reconnecting; holding game calls until it is back`);
		const deadline = this.now() + this.reconnectHoldMs;
		while (account.authenticated === false && this.now() < deadline) {
			await this.sleep(RECONNECT_POLL_MS);
		}
	}

	/**
	 * Resolve once neither an IP block nor this account's rate-limit hold is in
	 * force. With no `playerId` (an account not yet installed, still
	 * authenticating) only the IP block applies. Rejects if `signal` aborts.
	 */
	async waitUntilClear(playerId: string | undefined, signal?: AbortSignal): Promise<void> {
		for (;;) {
			signal?.throwIfAborted();
			const accountHold = playerId === undefined ? 0 : (this.accountHoldUntil.get(playerId) ?? 0);
			const waitMs = Math.max(this.ipBlockedUntil, accountHold) - this.now();
			if (waitMs <= 0) {
				if (playerId !== undefined && accountHold !== 0) this.accountHoldUntil.delete(playerId);
				return;
			}
			await this.sleepUnlessAborted(waitMs, signal);
		}
	}

	private sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
		if (signal === undefined) return this.sleep(ms);
		return new Promise<void>((resolve, reject) => {
			const onAbort = (): void => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			// The sleep is a timer and never rejects.
			void this.sleep(ms).then(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			});
		});
	}

	/**
	 * The lib's `scheduleSend` hook: hold each frame until it is clear to go.
	 * The lib aborts `signal` when the frame's socket is closed or replaced,
	 * which ends the hold.
	 */
	readonly scheduleSend = async (
		request: SendAdmissionRequest,
		send: () => void,
	): Promise<void> => {
		const playerId =
			request.accountId === undefined ? undefined : this.playerIdByAccountId.get(request.accountId);
		await this.waitUntilClear(playerId, request.signal);
		send();
	};

	/**
	 * Route an account's game calls through this gate: each `query` and
	 * `mutate` first waits out a reconnect, and a failure is inspected for an
	 * IP block. Patches the instance in place, so the object stays the same
	 * one. The holds themselves apply at `scheduleSend`.
	 */
	install(playerId: string, account: GatedAccount): void {
		if (account.id !== undefined) this.playerIdByAccountId.set(account.id, playerId);
		for (const method of ["query", "mutate"] as const) {
			const original = account[method].bind(account) as (...args: unknown[]) => Promise<unknown>;
			const gated = async (...args: unknown[]): Promise<unknown> => {
				await this.waitForConnection(playerId, account);
				if (method === "mutate") await this.handoverHolds.get(playerId);
				try {
					return await original(...args);
				} catch (err) {
					this.noteFailure(err);
					throw err;
				}
			};
			(account as unknown as Record<string, unknown>)[method] = gated;
		}
	}
}
