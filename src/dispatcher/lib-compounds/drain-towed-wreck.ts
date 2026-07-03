import type { LootWreckResponse } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { LibEnsureEmptyCargo } from "../lib-primitives/ensure-empty-cargo.js";

const log = createLogger("goal:drain-towed-wreck");

export interface DrainTowedWreckOptions {
	/** Id of the towed wreck to drain. */
	wreckId: string;
	/** Where to deposit looted cargo. Defaults to "personal". */
	storageTarget?: "personal" | "faction";
	/** Safety bound on loot↔deposit passes. Defaults to 30. */
	maxDrains?: number;
}

/** Loot a towed wreck dry, depositing to storage between passes. Must be docked at the yard. */
export class LibDrainTowedWreck implements LibGoal {
	readonly name = "drain-towed-wreck";
	private readonly options: DrainTowedWreckOptions;

	constructor(options: DrainTowedWreckOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
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

			const lootResponse = await ctx.account.commands.spacemolt_salvage.loot({
				id: this.options.wreckId,
			});
			ticksUsed++;
			const loot = lootResponse.delta.details as LootWreckResponse | undefined;

			const depositResult = await new LibEnsureEmptyCargo(depositOptions).execute(ctx);
			ticksUsed += depositResult.ticksUsed;

			if (loot?.wreck_empty) {
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
