import { createLogger } from "../../util/logger.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import { GoToPoi, NavigateToSystem } from "../primitives/index.js";

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
export class FuelRescue implements Goal {
	readonly name = "fuel-rescue";
	private readonly options: FuelRescueOptions;

	constructor(options: FuelRescueOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		let ticksUsed = 0;

		const navResult = await new NavigateToSystem(this.options.systemId).execute(ctx);
		ticksUsed += navResult.ticksUsed;
		if (!navResult.success) return failed(navResult.message, ticksUsed);

		const poiResult = await new GoToPoi(this.options.poiId).execute(ctx);
		ticksUsed += poiResult.ticksUsed;
		if (!poiResult.success) return failed(poiResult.message, ticksUsed);

		// Confirm the target player is present at this POI.
		const nearbyResp = await ctx.endpoints.getNearby();
		const sc = nearbyResp.structuredContent as Record<string, unknown>;
		const nearby = Array.isArray(sc["nearby"])
			? (sc["nearby"] as Array<Record<string, unknown>>)
			: [];

		const targetPresent = nearby.some(
			(ship) =>
				typeof ship["username"] === "string" &&
				ship["username"].toLowerCase() === this.options.targetUsername.toLowerCase(),
		);

		if (!targetPresent) {
			return failed(
				`Target player ${this.options.targetUsername} is not at POI ${this.options.poiId}`,
				ticksUsed,
			);
		}

		log.info(`Refueling ${this.options.targetUsername} at POI ${this.options.poiId}`);
		await ctx.endpoints.refuelTarget(this.options.targetUsername);
		ticksUsed++;

		return succeeded(`Refueled ${this.options.targetUsername}`, ticksUsed);
	}
}
