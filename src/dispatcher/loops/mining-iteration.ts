import { createLogger } from "../../util/logger.js";
import { PrepareAtStation } from "../compounds/prepare-at-station.js";
import type { PrepareAtStationOptions } from "../compounds/prepare-at-station.js";
import { SellAtStation } from "../compounds/sell-at-station.js";
import type { SellAtStationOptions } from "../compounds/sell-at-station.js";
import type { Goal, GoalContext, GoalResult } from "../goals.js";
import { runSequence } from "../sequence.js";

const log = createLogger("loop:mining");

export interface MiningIterationOptions {
	/** Name used in logs and step results (e.g. "mining-iteration", "enhanced-mining-iteration"). */
	iterationName: string;
	/**
	 * POI ID of the mining target (belt, salvage site, etc.) — passed to findRoute()
	 * so the fuel estimate includes intra-system travel to the belt, not just jumps.
	 * find_route accepts POI IDs and returns estimated_fuel for the full trip.
	 */
	miningPoiId: string;
	/** Pre-constructed run goal (MiningRun or EnhancedMiningRun). */
	runGoal: Goal;
	/** Options for SellAtStation (navigate, dock, refuel, sell). */
	sellOptions: SellAtStationOptions;
	/** Options for PrepareAtStation at the sell station — used for pre-flight refuel when fuel is low. */
	sellPrepareOptions: PrepareAtStationOptions;
	/**
	 * "mining": run the full iteration (fuel check → mine → sell).
	 * "selling": resources depleted — just sell/deposit remaining cargo.
	 */
	depletedPhase: "mining" | "selling";
	/**
	 * Extra fuel units to keep in reserve beyond the estimated round-trip cost.
	 * Covers intra-system travel and margin. Defaults to 0.
	 */
	minFuelReserve: number;
}

/**
 * A single mining loop iteration with a round-trip fuel safety check.
 *
 * Before departing for the mining belt, calls findRoute() to estimate the
 * total fuel needed for the round trip (outbound + return). If the ship does
 * not have enough fuel, it refuels at the sell station first, then proceeds.
 * NavigateToSystem's pre-flight check remains as a final guard against
 * departing with truly insufficient fuel (e.g. if refuel failed on credits).
 *
 * Shared by mining-loop and enhanced-mining-loop to avoid duplicating the
 * fuel-check logic.
 */
export class MiningIteration implements Goal {
	readonly name: string;

	constructor(private readonly options: MiningIterationOptions) {
		this.name = options.iterationName;
	}

	async execute(ctx: GoalContext): Promise<GoalResult> {
		if (this.options.depletedPhase === "selling") {
			log.info("Resources depleted — returning to station to sell/deposit remaining cargo");
			return new SellAtStation(this.options.sellOptions).execute(ctx);
		}

		// Check round-trip fuel before departing for the mining belt.
		// findRoute() with the belt POI ID gives estimated_fuel that includes both
		// the inter-system jumps AND intra-system travel to the belt, matching what
		// the ship will actually consume. The return trip is approximated as
		// fuel_per_jump * total_jumps (symmetric route assumption).
		const state = ctx.refreshState ? await ctx.refreshState() : ctx.state;
		const currentFuel = state.ship?.fuel ?? 0;
		const routeResult = await ctx.endpoints.findRoute(this.options.miningPoiId);
		const route = routeResult.structuredContent;
		const fuelNeeded =
			route.estimated_fuel + route.fuel_per_jump * route.total_jumps + this.options.minFuelReserve;

		let extraTicks = 0;

		if (currentFuel < fuelNeeded) {
			log.info(
				`Low fuel for mining round trip (have ${currentFuel}, need ${fuelNeeded}), refueling at sell station first`,
			);
			const prepResult = await new PrepareAtStation(this.options.sellPrepareOptions).execute(ctx);
			extraTicks += prepResult.ticksUsed;
			if (!prepResult.success) {
				return { ...prepResult, ticksUsed: extraTicks };
			}
		}

		const iterResult = await runSequence(
			[this.options.runGoal, new SellAtStation(this.options.sellOptions)],
			ctx,
		);
		return { ...iterResult, ticksUsed: extraTicks + iterResult.ticksUsed };
	}
}
