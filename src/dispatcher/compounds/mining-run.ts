import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult, Goal, GoalContext } from "../goals.js";
import { EnsureUndocked, GoToPoi, NavigateToSystem } from "../primitives/index.js";
import { runSequence } from "../sequence.js";
import { MineUntilFull } from "./mine-until-full.js";

const log = createLogger("goal:mining-run");

/** Options for the MiningRun compound goal. */
export interface MiningRunOptions {
	/** System containing the mining belt. */
	systemId: string;
	/** POI ID of the asteroid belt. */
	beltPoiId: string;
	/** Cargo fullness threshold passed to MineUntilFull. */
	fullThreshold?: number;
	/** Max mine attempts passed to MineUntilFull. */
	maxAttempts?: number;
}

/**
 * Execute a full mining run: travel to a belt and mine until cargo is full.
 *
 * Steps:
 * 1. NavigateToSystem — jump to the target system
 * 2. GoToPoi — travel to the asteroid belt
 * 3. EnsureUndocked — undock if docked (can't mine while docked)
 * 4. MineUntilFull — mine until cargo is at the threshold
 */
export class MiningRun implements Goal {
	readonly name = "mining-run";
	private readonly options: MiningRunOptions;

	constructor(options: MiningRunOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<CompoundGoalResult> {
		log.info(`Mining run: system=${this.options.systemId}, belt=${this.options.beltPoiId}`);

		// Phase 1: Travel to the belt
		const travelSteps: Goal[] = [
			new NavigateToSystem(this.options.systemId),
			new GoToPoi(this.options.beltPoiId),
			new EnsureUndocked(),
		];

		const travelResult = await runSequence(travelSteps, ctx);
		if (!travelResult.success) {
			return travelResult;
		}

		// Phase 2: Mine — need fresh state after travel
		const currentState = ctx.refreshState ? await ctx.refreshState() : ctx.state;

		const mineGoal = new MineUntilFull({
			...(this.options.fullThreshold !== undefined
				? { fullThreshold: this.options.fullThreshold }
				: {}),
			...(this.options.maxAttempts !== undefined ? { maxAttempts: this.options.maxAttempts } : {}),
		});

		const mineResult = await mineGoal.execute({
			endpoints: ctx.endpoints,
			state: currentState,
			...(ctx.refreshState ? { refreshState: ctx.refreshState } : {}),
		});

		const totalTicks = travelResult.ticksUsed + mineResult.ticksUsed;
		const allSatisfied = travelResult.alreadySatisfied && mineResult.alreadySatisfied;

		return {
			success: mineResult.success,
			message: mineResult.success
				? `Mining run complete (${totalTicks} tick(s))`
				: `Mining run failed during mining: ${mineResult.message}`,
			alreadySatisfied: allSatisfied,
			ticksUsed: totalTicks,
			steps: [...travelResult.steps, { goalName: mineGoal.name, result: mineResult }],
		};
	}
}
