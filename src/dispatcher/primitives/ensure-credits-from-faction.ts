import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";

const log = createLogger("goal:ensure-credits-from-faction");

/** Default minimum credit balance before withdrawing from faction storage. */
const DEFAULT_MIN_CREDITS = 1000;

/** Options for the EnsureCreditsFromFaction primitive. */
export interface EnsureCreditsFromFactionOptions {
	/** Minimum credit balance to maintain. Withdraws from faction storage if below this. Defaults to 1000. */
	minCredits?: number;
}

/**
 * Ensure the player has sufficient credits by withdrawing from faction storage if needed.
 *
 * Checks the player's current credit balance. If below the threshold,
 * queries faction storage for available credits and withdraws them.
 *
 * Already satisfied if credits >= minCredits.
 * Prerequisites: must be docked at a station.
 * Costs 0-1 ticks (0 if already satisfied, 1 for the withdrawal).
 */
export class EnsureCreditsFromFaction implements Goal {
	readonly name = "ensure-credits-from-faction";
	private readonly minCredits: number;

	constructor(options?: EnsureCreditsFromFactionOptions) {
		this.minCredits = options?.minCredits ?? DEFAULT_MIN_CREDITS;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot withdraw credits: must be docked at a station", 0);
		}

		const state = ctx.refreshState ? await ctx.refreshState() : ctx.state;
		const currentCredits = state.player?.credits ?? 0;

		if (currentCredits >= this.minCredits) {
			return alreadySatisfied(`Credits sufficient: ${currentCredits} >= ${this.minCredits}`);
		}

		// Query faction storage for available credits
		const storageResponse = await ctx.endpoints.viewFactionStorage();
		const availableCredits = storageResponse.structuredContent.credits ?? 0;

		if (availableCredits <= 0) {
			return alreadySatisfied(`Credits low (${currentCredits}) but no credits in faction storage`);
		}

		// Withdraw enough to reach the threshold, or all available
		const needed = this.minCredits - currentCredits;
		const toWithdraw = Math.min(needed, availableCredits);

		log.info(
			`Withdrawing ${toWithdraw} credits from faction storage (balance: ${currentCredits}, target: ${this.minCredits})`,
		);
		await ctx.endpoints.withdrawFromFactionStorage("credits", toWithdraw);

		return succeeded(
			`Withdrew ${toWithdraw} credits from faction storage (was: ${currentCredits}, target: ${this.minCredits})`,
			1,
		);
	}
}
