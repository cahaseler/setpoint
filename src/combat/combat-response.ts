/**
 * Pluggable combat-response strategies, invoked by `CombatReactor`
 * (`combat-reactor.ts`) once an account is confirmed in combat. `FleeCombatStrategy`
 * is the one strategy setpoint ships today — the interface exists so a future
 * strategy (fight-back, call-for-help, ...) can be added without touching
 * detection or interrupt logic.
 */

import type { GetBattleStatusResponse, QueryResult } from "@spacemolt/lib";
import type { LibGoalAccount } from "../dispatcher/lib-goal-context.js";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("combat-response");

// Game mutations queue for the next ~10s tick (see CLAUDE.md) — space flee
// attempts one tick apart rather than hammering the query in a tight loop.
const FLEE_ATTEMPT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 8;

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

export interface CombatResponseContext {
	account: LibGoalAccount;
	battleId: string;
	signal?: AbortSignal;
}

export interface CombatResponseResult {
	success: boolean;
	message: string;
	ticksUsed: number;
}

export interface CombatResponseStrategy {
	readonly name: string;
	respond(ctx: CombatResponseContext): Promise<CombatResponseResult>;
}

export interface FleeCombatStrategyOptions {
	/** Bounded retry budget — a "still in combat" result after this many attempts is a failure, not an infinite retry. Defaults to 8. */
	maxAttempts?: number;
	/** Delay between attempts, in ms. Defaults to one game tick (~10s); tests override this to keep runs fast. */
	attemptIntervalMs?: number;
}

/**
 * Attempts to escape combat via the `flee` stance (which auto-retreats to
 * the outer ring and takes 3 consecutive flee ticks to actually escape —
 * see `SpacemoltBattleStanceParams`'s doc comment). Bounded: gives up after
 * `maxAttempts` ticks still in combat, rather than retrying forever.
 */
export class FleeCombatStrategy implements CombatResponseStrategy {
	readonly name = "flee";
	private readonly maxAttempts: number;
	private readonly attemptIntervalMs: number;

	constructor(options: FleeCombatStrategyOptions = {}) {
		this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		this.attemptIntervalMs = options.attemptIntervalMs ?? FLEE_ATTEMPT_INTERVAL_MS;
	}

	async respond(ctx: CombatResponseContext): Promise<CombatResponseResult> {
		for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
			if (ctx.signal?.aborted) {
				return { success: false, message: "flee aborted", ticksUsed: attempt - 1 };
			}

			try {
				await ctx.account.commands.spacemolt_battle.stance({ id: "flee" });
			} catch (err) {
				log.warn(
					`[${ctx.battleId}] flee stance call failed on attempt ${attempt}: ${errorMessage(err)}`,
				);
			}

			let status: QueryResult<GetBattleStatusResponse> | undefined;
			try {
				status = await ctx.account.commands.spacemolt_battle.status();
			} catch (err) {
				log.warn(
					`[${ctx.battleId}] battle status check failed on attempt ${attempt}: ${errorMessage(err)}`,
				);
			}

			const content = status?.structuredContent;
			if (content && !content.is_participant) {
				return { success: true, message: "no longer a battle participant", ticksUsed: attempt };
			}
			const combatState = content?.combat_state;
			if (
				combatState &&
				combatState.flee_required !== undefined &&
				combatState.flee_counter >= combatState.flee_required
			) {
				return { success: true, message: "flee counter satisfied", ticksUsed: attempt };
			}

			if (attempt < this.maxAttempts) {
				await abortableDelay(this.attemptIntervalMs, ctx.signal);
			}
		}

		return {
			success: false,
			message: `flee attempts exhausted (${this.maxAttempts}), still in combat`,
			ticksUsed: this.maxAttempts,
		};
	}
}
