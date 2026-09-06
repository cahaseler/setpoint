import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { LibEnsureFueled } from "../lib-primitives/ensure-fueled.js";

const log = createLogger("loop:mining");

export interface FuelRouteGuardOptions {
	/** Name used in logs and step results. */
	name: string;
	/** POI ID of the destination this guard protects the trip to (e.g. the sell station). */
	destinationPoiId: string;
	/** Extra fuel units to keep in reserve beyond the estimated route cost. */
	minFuelReserve: number;
}

/**
 * Fails the iteration before a leg begins if current fuel can't cover the
 * estimated route to `destinationPoiId`, instead of departing and stranding
 * mid-route with a full hold and no way back. Attempts an in-place refuel
 * first if currently docked — the common case right after mining is
 * undocked at a remote belt with no fuel seller nearby, so this is mostly
 * defensive for setups where the run ends somewhere refuelable.
 *
 * Complements LibMiningIteration's own pre-flight round-trip check: that
 * check estimates the full round trip before departure; this one re-checks
 * with the ship's actual fuel and position right before the return leg,
 * catching any deviation from that estimate (extra jumps, combat, drift).
 */
export class LibFuelRouteGuard implements LibGoal {
	readonly name: string;

	constructor(private readonly options: FuelRouteGuardOptions) {
		this.name = options.name;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		const state = await ctx.refreshState();
		const currentFuel = state.ship?.fuel ?? 0;
		const routeResult = await ctx.account.commands.spacemolt.find_route({
			id: this.options.destinationPoiId,
		});
		const route = routeResult.structuredContent;
		const fuelNeeded = (route?.estimated_fuel ?? 0) + this.options.minFuelReserve;

		if (currentFuel >= fuelNeeded) {
			return alreadySatisfied(
				`Fuel sufficient for route (have ${currentFuel}, need ${fuelNeeded})`,
			);
		}

		log.warn(`Fuel below route minimum before departing (have ${currentFuel}, need ${fuelNeeded})`);

		let ticksUsed = 0;
		if (state.location?.docked_at) {
			const refuelResult = await new LibEnsureFueled(undefined, { requireFull: false }).execute(
				ctx,
			);
			ticksUsed += refuelResult.ticksUsed;
			const refueledAmount = ctx.state.ship?.fuel ?? currentFuel;
			if (refueledAmount >= fuelNeeded) {
				return succeeded(
					`Refueled before departure (${refueledAmount}, needed ${fuelNeeded})`,
					ticksUsed,
				);
			}
		}

		return failed(
			`fuel_below_route_minimum: have ${currentFuel}, need ${fuelNeeded} to reach destination and refuel is not possible from here`,
			ticksUsed,
		);
	}
}
