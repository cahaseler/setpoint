import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult, Goal, GoalContext } from "../goals.js";
import { EnsureUndocked, GoToPoi, NavigateToSystem } from "../primitives/index.js";
import { runSequence } from "../sequence.js";
import { MineWithJettison } from "./mine-with-jettison.js";

const log = createLogger("goal:enhanced-mining-run");

/** Options for the EnhancedMiningRun compound goal. */
export interface EnhancedMiningRunOptions {
	/** System containing the mining belt. */
	systemId: string;
	/** POI ID of the asteroid belt. */
	beltPoiId: string;
	/** Item IDs considered junk — will be jettisoned when cargo is full. */
	junkItemIds: string[];
	/** Cargo fullness threshold passed to MineWithJettison. */
	fullThreshold?: number;
	/** Max total mine attempts passed to MineWithJettison. */
	maxAttempts?: number;
	/** Max jettison-then-mine cycles passed to MineWithJettison. */
	maxJettisonRounds?: number;
}

/**
 * Execute a full enhanced mining run: travel to a belt and mine until cargo
 * is full with valuable ore, jettisoning junk along the way.
 *
 * Steps:
 * 1. NavigateToSystem — jump to the target system
 * 2. GoToPoi — travel to the asteroid belt
 * 3. EnsureUndocked — undock if docked (can't mine while docked)
 * 4. MineWithJettison — mine, jettison junk, mine again until truly full
 */
export class EnhancedMiningRun implements Goal {
	readonly name = "enhanced-mining-run";
	private readonly options: EnhancedMiningRunOptions;

	constructor(options: EnhancedMiningRunOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<CompoundGoalResult> {
		log.info(
			`Enhanced mining run: system=${this.options.systemId}, belt=${this.options.beltPoiId}`,
		);

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

		// Phase 2: Mine with jettison — need fresh state after travel
		const currentState = ctx.refreshState ? await ctx.refreshState() : ctx.state;

		const mineGoal = new MineWithJettison({
			junkItemIds: this.options.junkItemIds,
			...(this.options.fullThreshold !== undefined
				? { fullThreshold: this.options.fullThreshold }
				: {}),
			...(this.options.maxAttempts !== undefined ? { maxAttempts: this.options.maxAttempts } : {}),
			...(this.options.maxJettisonRounds !== undefined
				? { maxJettisonRounds: this.options.maxJettisonRounds }
				: {}),
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
				? `Enhanced mining run complete (${totalTicks} tick(s))`
				: `Enhanced mining run failed during mining: ${mineResult.message}`,
			alreadySatisfied: allSatisfied,
			ticksUsed: totalTicks,
			steps: [...travelResult.steps, { goalName: mineGoal.name, result: mineResult }],
		};
	}
}
