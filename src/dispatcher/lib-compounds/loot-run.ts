import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { LibEnsureUndocked } from "../lib-primitives/ensure-undocked.js";
import { LibGoToPoi } from "../lib-primitives/go-to-poi.js";
import { LibNavigateToSystem } from "../lib-primitives/navigate-to-system.js";
import { runLibSequence } from "../lib-sequence.js";
import { LibLootUntilFull } from "./loot-until-full.js";

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
export class LibLootRun implements LibGoal {
	readonly name = "loot-run";
	private readonly options: LootRunOptions;

	constructor(options: LootRunOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<CompoundGoalResult> {
		log.info(`Loot run: system=${this.options.systemId}, poi=${this.options.salvagePoiId}`);

		// Phase 1: Travel to the salvage site
		const travelSteps: LibGoal[] = [
			new LibNavigateToSystem(this.options.systemId),
			new LibGoToPoi(this.options.salvagePoiId),
			new LibEnsureUndocked(),
		];

		const travelResult = await runLibSequence(travelSteps, ctx);
		if (!travelResult.success) {
			return travelResult;
		}

		// Phase 2: Loot — need fresh state after travel
		await ctx.refreshState();

		const lootGoal = new LibLootUntilFull({
			...(this.options.fullThreshold !== undefined
				? { fullThreshold: this.options.fullThreshold }
				: {}),
			...(this.options.maxAttempts !== undefined ? { maxAttempts: this.options.maxAttempts } : {}),
		});

		const lootResult = await lootGoal.execute(ctx);

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
