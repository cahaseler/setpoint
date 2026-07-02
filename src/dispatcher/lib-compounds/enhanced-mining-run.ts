import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { LibEnsureUndocked } from "../lib-primitives/ensure-undocked.js";
import { LibGoToPoi } from "../lib-primitives/go-to-poi.js";
import { LibNavigateToSystem } from "../lib-primitives/navigate-to-system.js";
import { runLibSequence } from "../lib-sequence.js";
import { LibMineWithJettison } from "./mine-with-jettison.js";

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
export class LibEnhancedMiningRun implements LibGoal {
	readonly name = "enhanced-mining-run";
	private readonly options: EnhancedMiningRunOptions;

	constructor(options: EnhancedMiningRunOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<CompoundGoalResult> {
		log.info(
			`Enhanced mining run: system=${this.options.systemId}, belt=${this.options.beltPoiId}`,
		);

		// Phase 1: Travel to the belt
		const travelSteps: LibGoal[] = [
			new LibNavigateToSystem(this.options.systemId),
			new LibGoToPoi(this.options.beltPoiId),
			new LibEnsureUndocked(),
		];

		const travelResult = await runLibSequence(travelSteps, ctx);
		if (!travelResult.success) {
			return travelResult;
		}

		// Phase 2: Mine with jettison — need fresh state after travel
		await ctx.refreshState();

		const mineGoal = new LibMineWithJettison({
			junkItemIds: this.options.junkItemIds,
			...(this.options.fullThreshold !== undefined
				? { fullThreshold: this.options.fullThreshold }
				: {}),
			...(this.options.maxAttempts !== undefined ? { maxAttempts: this.options.maxAttempts } : {}),
			...(this.options.maxJettisonRounds !== undefined
				? { maxJettisonRounds: this.options.maxJettisonRounds }
				: {}),
		});

		const mineResult = await mineGoal.execute(ctx);

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
