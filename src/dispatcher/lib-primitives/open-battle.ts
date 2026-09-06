import type { BattleResponse, GetBattleStatusResponse } from "@spacemolt/lib";
import { SpacemoltError } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("goal:open-battle");

export interface OpenBattleOptions {
	/**
	 * `"attack"` opens on a named target; `"engage"` joins an existing battle on
	 * a given side.
	 *
	 * The arena's own `fight` entry point is deliberately absent: it is not in
	 * the command surface `@spacemolt/lib` generates from the server spec, so
	 * there is no typed call to make. Reach it through the raw passthrough until
	 * a lib version exposes it, rather than hand-writing the wire shape here.
	 */
	mode: "attack" | "engage";
	/** Target id, for `mode: "attack"`. */
	targetId?: string;
	/** Side to join, for `mode: "engage"`. */
	sideId?: number;
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
		if (this.options.mode === "attack") {
			return this.attack(ctx);
		}
		return this.engage(ctx);
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
