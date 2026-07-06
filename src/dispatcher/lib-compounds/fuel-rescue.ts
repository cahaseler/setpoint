import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { LibGoToPoi } from "../lib-primitives/go-to-poi.js";
import { LibNavigateToSystem } from "../lib-primitives/navigate-to-system.js";

const log = createLogger("goal:fuel-rescue");

/** Options for the FuelRescue compound goal. */
export interface FuelRescueOptions {
	/** System containing the rescue target's POI. */
	systemId: string;
	/** POI ID where the stranded player should be located. */
	poiId: string;
	/** Username of the player to rescue. */
	targetUsername: string;
}

/**
 * Travel to a POI, then refuel the target player directly.
 *
 * Does NOT pre-check the target's presence via get_nearby: that query
 * collapses offline players (exactly what a fuel-starved, stranded target
 * usually is) into an `offline_collapsed` count once a POI is crowded,
 * dropping them out of the named `nearby` list even though they're still
 * genuinely there and refuelable — a get_nearby-based precondition produced
 * false-negative failures for targets that a direct refuel() reached fine.
 * refuel() itself is the authoritative check for reachability; its own
 * failure (if the target truly isn't there) is reported as-is.
 *
 * Steps:
 * 1. NavigateToSystem — jump to the target system (no-op if already there)
 * 2. GoToPoi — travel to the rescue POI (no-op if already there)
 * 3. refuel(target) — deliver fuel to the stranded player (1 tick)
 */
export class LibFuelRescue implements LibGoal {
	readonly name = "fuel-rescue";
	private readonly options: FuelRescueOptions;

	constructor(options: FuelRescueOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		let ticksUsed = 0;

		const navResult = await new LibNavigateToSystem(this.options.systemId).execute(ctx);
		ticksUsed += navResult.ticksUsed;
		if (!navResult.success) return failed(navResult.message, ticksUsed);

		const poiResult = await new LibGoToPoi(this.options.poiId).execute(ctx);
		ticksUsed += poiResult.ticksUsed;
		if (!poiResult.success) return failed(poiResult.message, ticksUsed);

		log.info(`Refueling ${this.options.targetUsername} at POI ${this.options.poiId}`);
		try {
			await ctx.account.commands.spacemolt.refuel({ target: this.options.targetUsername });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return failed(`Refuel of ${this.options.targetUsername} failed: ${msg}`, ticksUsed);
		}
		ticksUsed++;

		return succeeded(`Refueled ${this.options.targetUsername}`, ticksUsed);
	}
}
