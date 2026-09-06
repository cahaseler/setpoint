import type { ArenaFightResponse, BattleResponse, GetBattleStatusResponse } from "@spacemolt/lib";
import { SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:open-battle");

export interface OpenBattleOptions {
	/**
	 * The three ways a fight starts: `"arena"` opens a consequence-free arena
	 * challenge, `"attack"` opens on a named target, `"engage"` joins an
	 * existing battle on a given side.
	 */
	mode: "arena" | "attack" | "engage";
	/** Target id, for `mode: "attack"`. */
	targetId?: string;
	/** Side to join, for `mode: "engage"`. */
	sideId?: number;
	/** Challenge to open, for `mode: "arena"`. */
	challengeId?: string;
}

/**
 * Open a battle and report the id it opened.
 *
 * `attack` does not return a battle id of its own, so the id is read back from
 * battle status — a query, costing no tick — rather than left for the caller to
 * chase.
 */
export class LibOpenBattle implements LibGoal {
	readonly name = "open-battle";

	constructor(private readonly options: OpenBattleOptions) {}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (this.options.mode === "arena") {
			return this.arena(ctx);
		}
		if (this.options.mode === "attack") {
			return this.attack(ctx);
		}
		return this.engage(ctx);
	}

	/**
	 * Open an arena challenge. Unlike the other two, this reports its battle id
	 * directly, and a locked challenge is a precondition failure rather than
	 * something to retry — the caller has to unlock it first.
	 */
	private async arena(ctx: LibGoalContext): Promise<GoalResult> {
		const challengeId = this.options.challengeId;
		if (challengeId === undefined) {
			return failed("open-battle: challengeId is required for mode 'arena'", 0);
		}

		log.info(`Opening arena challenge ${challengeId}`);
		try {
			const response = await ctx.account.commands.spacemolt_arena.fight({ id: challengeId });
			const details = response.delta.details as ArenaFightResponse | undefined;
			return succeeded(
				`Opened arena challenge ${challengeId}, battle ${details?.battle_id ?? "unknown"}`,
				1,
			);
		} catch (err) {
			if (err instanceof SpacemoltError) {
				return failed(`arena_fight_failed (${err.code}): ${err.message}`, 0);
			}
			throw err;
		}
	}

	private async attack(ctx: LibGoalContext): Promise<GoalResult> {
		const targetId = this.options.targetId;
		if (targetId === undefined) {
			return failed("open-battle: targetId is required for mode 'attack'", 0);
		}

		log.info(`Attacking ${targetId}`);
		try {
			await ctx.account.commands.spacemolt.attack({ id: targetId });
		} catch (err) {
			if (err instanceof SpacemoltError) {
				return failed(`attack_failed (${err.code}): ${err.message}`, 0);
			}
			throw err;
		}

		const battleId = await this.currentBattleId(ctx);
		return succeeded(
			battleId === undefined
				? `Attacked ${targetId} (battle id not yet reported)`
				: `Attacked ${targetId}, battle ${battleId}`,
			1,
		);
	}

	private async engage(ctx: LibGoalContext): Promise<GoalResult> {
		const sideId = this.options.sideId;
		log.info(`Engaging${sideId === undefined ? "" : ` on side ${sideId}`}`);
		try {
			const response = await ctx.account.commands.spacemolt_battle.engage(
				sideId === undefined ? {} : { side_id: sideId },
			);
			const details = response.structuredContent as BattleResponse | undefined;
			const battleId = details?.battle_id ?? (await this.currentBattleId(ctx));
			return succeeded(
				battleId === undefined ? "Engaged (battle id not reported)" : `Engaged battle ${battleId}`,
				1,
			);
		} catch (err) {
			if (err instanceof SpacemoltError) {
				return failed(`engage_failed (${err.code}): ${err.message}`, 0);
			}
			throw err;
		}
	}

	/** Read the battle this account is currently in, if any. A query: no tick. */
	private async currentBattleId(ctx: LibGoalContext): Promise<string | undefined> {
		try {
			const status = await ctx.account.commands.spacemolt_battle.status();
			return (status.structuredContent as GetBattleStatusResponse | undefined)?.battle_id;
		} catch {
			// Not being in a battle is a legitimate answer here, not an error worth
			// failing the goal over — the mutation above already succeeded.
			return undefined;
		}
	}
}
