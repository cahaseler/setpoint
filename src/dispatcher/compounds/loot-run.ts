import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult, Goal, GoalContext } from "../goals.js";
import { EnsureUndocked, GoToPoi, NavigateToSystem } from "../primitives/index.js";
import { runSequence } from "../sequence.js";
import { LootUntilFull } from "./loot-until-full.js";

const log = createLogger("goal:loot-run");

/** Options for the LootRun compound goal. */
export interface LootRunOptions {
	/** System containing the salvage site. */
	systemId: string;
	/** POI ID of the salvage site. */
	salvagePoiId: string;
	/** Cargo fullness threshold passed to LootUntilFull. */
	fullThreshold?: number;
	/** Max loot attempts passed to LootUntilFull. */
	maxAttempts?: number;
}

/**
 * Execute a full loot run: travel to a salvage site and loot wrecks until cargo is full.
 *
 * Steps:
 * 1. NavigateToSystem — jump to the target system
 * 2. GoToPoi — travel to the salvage site
 * 3. EnsureUndocked — undock if docked (can't loot while docked)
 * 4. LootUntilFull — loot wrecks until cargo is at the threshold
 */
export class LootRun implements Goal {
	readonly name = "loot-run";
	private readonly options: LootRunOptions;

	constructor(options: LootRunOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<CompoundGoalResult> {
		log.info(`Loot run: system=${this.options.systemId}, poi=${this.options.salvagePoiId}`);

		// Phase 1: Travel to the salvage site
		const travelSteps: Goal[] = [
			new NavigateToSystem(this.options.systemId),
			new GoToPoi(this.options.salvagePoiId),
			new EnsureUndocked(),
		];

		const travelResult = await runSequence(travelSteps, ctx);
		if (!travelResult.success) {
			return travelResult;
		}

		// Phase 2: Loot — need fresh state after travel
		const currentState = ctx.refreshState ? await ctx.refreshState() : ctx.state;

		const lootGoal = new LootUntilFull({
			...(this.options.fullThreshold !== undefined
				? { fullThreshold: this.options.fullThreshold }
				: {}),
			...(this.options.maxAttempts !== undefined ? { maxAttempts: this.options.maxAttempts } : {}),
		});

		const lootResult = await lootGoal.execute({
			endpoints: ctx.endpoints,
			state: currentState,
			...(ctx.refreshState ? { refreshState: ctx.refreshState } : {}),
		});

		const totalTicks = travelResult.ticksUsed + lootResult.ticksUsed;
		const allSatisfied = travelResult.alreadySatisfied && lootResult.alreadySatisfied;

		return {
			success: lootResult.success,
			message: lootResult.success
				? `Loot run complete (${totalTicks} tick(s))`
				: `Loot run failed: ${lootResult.message}`,
			alreadySatisfied: allSatisfied,
			ticksUsed: totalTicks,
			steps: [...travelResult.steps, { goalName: lootGoal.name, result: lootResult }],
		};
	}
}
