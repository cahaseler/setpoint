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
 * Travel to a POI, confirm the target player is present via get_nearby,
 * then refuel them.
 *
 * Fails immediately if the target player is not found at the POI after arrival.
 *
 * Steps:
 * 1. NavigateToSystem — jump to the target system (no-op if already there)
 * 2. GoToPoi — travel to the rescue POI (no-op if already there)
 * 3. get_nearby — confirm the target player is present
 * 4. refuel(target) — deliver fuel to the stranded player (1 tick)
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

		// Confirm the target player is present at this POI.
		const nearbyResponse = await ctx.account.commands.spacemolt.get_nearby();
		const nearby = nearbyResponse.structuredContent?.nearby ?? [];

		const targetPresent = nearby.some(
			(ship) => ship.username?.toLowerCase() === this.options.targetUsername.toLowerCase(),
		);

		if (!targetPresent) {
			return failed(
				`Target player ${this.options.targetUsername} is not at POI ${this.options.poiId}`,
				ticksUsed,
			);
		}

		log.info(`Refueling ${this.options.targetUsername} at POI ${this.options.poiId}`);
		await ctx.account.commands.spacemolt.refuel({ target: this.options.targetUsername });
		ticksUsed++;

		return succeeded(`Refueled ${this.options.targetUsername}`, ticksUsed);
	}
}
