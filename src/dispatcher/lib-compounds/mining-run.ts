import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { LibEnsureUndocked } from "../lib-primitives/ensure-undocked.js";
import { LibGoToPoi } from "../lib-primitives/go-to-poi.js";
import { LibNavigateToSystem } from "../lib-primitives/navigate-to-system.js";
import { runLibSequence } from "../lib-sequence.js";
import { LibMineUntilFull } from "./mine-until-full.js";

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
export class LibMiningRun implements LibGoal {
	readonly name = "mining-run";
	private readonly options: MiningRunOptions;

	constructor(options: MiningRunOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<CompoundGoalResult> {
		log.info(`Mining run: system=${this.options.systemId}, belt=${this.options.beltPoiId}`);

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

		// Phase 2: Mine — need fresh state after travel
		await ctx.refreshState();

		const mineGoal = new LibMineUntilFull({
			...(this.options.fullThreshold !== undefined
				? { fullThreshold: this.options.fullThreshold }
				: {}),
			...(this.options.maxAttempts !== undefined ? { maxAttempts: this.options.maxAttempts } : {}),
		});

		const mineResult = await mineGoal.execute(ctx);

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
