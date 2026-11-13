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
 * Installed by wrapping `query` and `mutate` on each account instance (see
 * `install`). Every game call funnels through those two — `commands`, `send`,
 * `refresh` and the subscribe calls included — and wrapping the instance's own
 * methods keeps its identity, which `state-freshness.ts` keys on.
 *
 * The lib's own retry of an already-throttled call happens inside `query` and
 * `mutate`, past this gate. That is deliberate: it waits the server's own
 * interval, which is exactly the window this gate holds new calls for.
 */

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

export interface GameCallGateOptions {
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	reconnectHoldMs?: number;
}

export class GameCallGate {
	private ipBlockedUntil = 0;
	private readonly accountHoldUntil = new Map<string, number>();
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly reconnectHoldMs: number;

	constructor({
		now = Date.now,
		sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
		reconnectHoldMs = RECONNECT_HOLD_MS,
	}: GameCallGateOptions = {}) {
		this.now = now;
		this.sleep = sleep;
		this.reconnectHoldMs = reconnectHoldMs;
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

	/** Resolve once neither an IP block nor this account's rate-limit hold is in force. */
	async waitUntilClear(playerId: string): Promise<void> {
		for (;;) {
			const accountHold = this.accountHoldUntil.get(playerId) ?? 0;
			const waitMs = Math.max(this.ipBlockedUntil, accountHold) - this.now();
			if (waitMs <= 0) {
				if (accountHold !== 0) this.accountHoldUntil.delete(playerId);
				return;
			}
			await this.sleep(waitMs);
		}
	}

	/**
	 * Route an account's game calls through this gate: each `query` and
	 * `mutate` first waits until clear, and a failure is inspected for an IP
	 * block. Patches the instance in place, so the object stays the same one.
	 */
	install(playerId: string, account: GatedAccount): void {
		for (const method of ["query", "mutate"] as const) {
			const original = account[method].bind(account) as (...args: unknown[]) => Promise<unknown>;
			const gated = async (...args: unknown[]): Promise<unknown> => {
				await this.waitForConnection(playerId, account);
				await this.waitUntilClear(playerId);
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
