import { createLogger } from "../../util/logger.js";
import { type Goal, type GoalContext, type GoalResult, failed, succeeded } from "../goals.js";
import { EnsureEmptyCargo } from "../primitives/ensure-empty-cargo.js";

const log = createLogger("goal:drain-towed-wreck");

export interface DrainTowedWreckOptions {
	/** Id of the towed wreck to drain. */
	wreckId: string;
	/** Where to deposit looted cargo. Defaults to "personal". */
	storageTarget?: "personal" | "faction";
	/** Safety bound on loot↔deposit passes. Defaults to 30. */
	maxDrains?: number;
}

interface LootResult {
	wreck_empty?: boolean;
	quantity?: number;
}

/** Loot a towed wreck dry, depositing to storage between passes. Must be docked at the yard. */
export class DrainTowedWreck implements Goal {
	readonly name = "drain-towed-wreck";
	private readonly options: DrainTowedWreckOptions;

	constructor(options: DrainTowedWreckOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (!ctx.state.location?.docked_at) {
			return failed("Cannot drain wreck: must be docked at the yard", 0);
		}

		const maxDrains = this.options.maxDrains ?? 30;
		const depositOptions =
			this.options.storageTarget !== undefined ? { depositTarget: this.options.storageTarget } : {};
		let ticksUsed = 0;

		for (let pass = 0; pass < maxDrains; pass++) {
			if (ctx.signal?.aborted) {
				return failed(`Drain aborted after ${ticksUsed} tick(s)`, ticksUsed);
			}

			const lootResp = await ctx.endpoints.lootWreck(this.options.wreckId);
			ticksUsed++;
			const loot = lootResp.structuredContent as unknown as LootResult;

			const depositResult = await new EnsureEmptyCargo(depositOptions).execute(
				ctx.refreshState ? { ...ctx, state: await ctx.refreshState() } : ctx,
			);
			ticksUsed += depositResult.ticksUsed;

			if (loot.wreck_empty) {
				return succeeded(
					`Drained wreck ${this.options.wreckId} in ${pass + 1} pass(es)`,
					ticksUsed,
				);
			}
		}

		log.warn(`Drain hit the ${maxDrains}-pass cap on ${this.options.wreckId}`);
		return failed(`Wreck ${this.options.wreckId} not empty after ${maxDrains} passes`, ticksUsed);
	}
}
