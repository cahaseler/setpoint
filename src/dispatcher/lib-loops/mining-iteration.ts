import { createLogger } from "../../util/logger.js";
import type { GoalResult } from "../goals.js";
import { LibPrepareAtStation } from "../lib-compounds/prepare-at-station.js";
import type { PrepareAtStationOptions } from "../lib-compounds/prepare-at-station.js";
import { LibSellAtStation } from "../lib-compounds/sell-at-station.js";
import type { SellAtStationOptions } from "../lib-compounds/sell-at-station.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { runLibSequence } from "../lib-sequence.js";
import { LibFuelRouteGuard } from "./fuel-route-guard.js";

const log = createLogger("loop:mining");

export interface MiningIterationOptions {
	/** Name used in logs and step results (e.g. "mining-iteration", "enhanced-mining-iteration"). */
	iterationName: string;
	/**
	 * POI ID of the mining target (belt, salvage site, etc.) — passed to find_route()
	 * so the fuel estimate includes intra-system travel to the belt, not just jumps.
	 * find_route accepts POI IDs and returns estimated_fuel for the full trip.
	 */
	miningPoiId: string;
	/** Pre-constructed run goal (LibMiningRun or LibEnhancedMiningRun). */
	runGoal: LibGoal;
	/** Options for LibSellAtStation (navigate, dock, refuel, sell). */
	sellOptions: SellAtStationOptions;
	/** Options for LibPrepareAtStation at the sell station — used for pre-flight refuel when fuel is low. */
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
 * Before departing for the mining belt, calls find_route() to estimate the
 * total fuel needed for the round trip (outbound + return). If the ship does
 * not have enough fuel, it refuels at the sell station first, then proceeds.
 * LibNavigateToSystem's pre-flight check remains as a final guard against
 * departing with truly insufficient fuel (e.g. if refuel failed on credits).
 *
 * Shared by mining-loop and enhanced-mining-loop to avoid duplicating the
 * fuel-check logic.
 */
export class LibMiningIteration implements LibGoal {
	readonly name: string;

	constructor(private readonly options: MiningIterationOptions) {
		this.name = options.iterationName;
	}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		if (this.options.depletedPhase === "selling") {
			log.info("Resources depleted — returning to station to sell/deposit remaining cargo");
			return new LibSellAtStation(this.options.sellOptions).execute(ctx);
		}

		// Check round-trip fuel before departing for the mining belt.
		// find_route() with the belt POI ID gives estimated_fuel that includes both
		// the inter-system jumps AND intra-system travel to the belt, matching what
		// the ship will actually consume. The return trip is approximated as
		// fuel_per_jump * total_jumps (symmetric route assumption).
		const state = await ctx.refreshState();
		const currentFuel = state.ship?.fuel ?? 0;
		const routeResult = await ctx.account.commands.spacemolt.find_route({
			id: this.options.miningPoiId,
		});
		const route = routeResult.structuredContent;
		const fuelNeeded =
			(route?.estimated_fuel ?? 0) +
			(route?.fuel_per_jump ?? 0) * (route?.total_jumps ?? 0) +
			this.options.minFuelReserve;

		let extraTicks = 0;

		if (currentFuel < fuelNeeded) {
			log.info(
				`Low fuel for mining round trip (have ${currentFuel}, need ${fuelNeeded}), refueling at sell station first`,
			);
			const prepResult = await new LibPrepareAtStation(this.options.sellPrepareOptions).execute(
				ctx,
			);
			extraTicks += prepResult.ticksUsed;
			if (!prepResult.success) {
				return { ...prepResult, ticksUsed: extraTicks };
			}
		}

		const iterResult = await runLibSequence(
			[
				this.options.runGoal,
				// Re-check fuel against the actual return route right before the
				// deposit leg — the pre-flight check above estimated the whole round
				// trip before departure, but combat, drift, or extra jumps during the
				// run can leave less fuel than that estimate assumed. Failing here
				// instead of departing prevents stranding mid-route with a full hold.
				new LibFuelRouteGuard({
					name: "fuel-route-guard",
					destinationPoiId: this.options.sellOptions.stationPoiId,
					minFuelReserve: this.options.minFuelReserve,
				}),
				new LibSellAtStation(this.options.sellOptions),
			],
			ctx,
		);
		return { ...iterResult, ticksUsed: extraTicks + iterResult.ticksUsed };
	}
}
