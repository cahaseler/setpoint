import type { StoredGameState } from "../../state/store.js";
import { createLogger } from "../../util/logger.js";
import { PrepareAtStation } from "../compounds/prepare-at-station.js";
import type { Goal, GoalContext, GoalResult, LoopOptions, LoopResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import { runLoop } from "../loops.js";
import { EnsureUndocked, GoToPoi, NavigateToSystem } from "../primitives/index.js";
import { SequenceGoal } from "../sequence-goal.js";

const log = createLogger("loop:guard");

/** Options for the GuardLoop. */
export interface GuardLoopOptions {
	/** System containing the home base (for refuel and repair). */
	homeSystemId: string;
	/** POI ID of the home station. */
	homeStationPoiId: string;
	/** Base ID to dock at for refueling and repair. */
	homeBaseId: string;
	/** System containing the POI to guard. */
	guardSystemId: string;
	/** POI ID to guard. */
	guardPoiId: string;
	/** When set to "faction", withdraws credits from the faction treasury if credits are low before refueling. */
	cashSource?: "faction";
	/** Minimum credit balance before withdrawing from storage. */
	minCredits?: number;
	/**
	 * Hull percentage below which the ship returns home to repair and refuel.
	 * 100 = repair on any damage; 80 = only return home below 80% hull.
	 * Default: 100.
	 */
	repairThreshold?: number;
	/**
	 * Fuel percentage below which the ship returns home to refuel.
	 * 50 = return home when tank is below 50%. Prevents stranding at the guard POI.
	 * Default: 0 (only return on hull damage, not on low fuel).
	 */
	fuelThreshold?: number;
	/** Loop control options (signal, maxIterations, shouldContinue). */
	loopOptions?: LoopOptions;
}

/**
 * Module-private goal that attacks all pirates at the current POI.
 *
 * Loops: call get_nearby → if pirates present, check hull (fail if 0), attack
 * the first pirate → repeat. Exits when the area is clear or hull reaches 0.
 *
 * Each attack() call is one tick. Combat requires repeated calls until the
 * pirate is gone from get_nearby.
 */
class ClearPirates implements Goal {
	readonly name = "clear-pirates";

	async execute(ctx: GoalContext): Promise<GoalResult> {
		let ticksUsed = 0;

		for (;;) {
			// Check for external cancellation between attacks — combat is unbounded,
			// and a force abort must not wait for the area to clear.
			if (ctx.signal?.aborted) {
				return failed(`Combat aborted after ${ticksUsed} attack(s)`, ticksUsed);
			}

			const nearbyResp = await ctx.endpoints.getNearby();
			const sc = nearbyResp.structuredContent as Record<string, unknown>;
			const pirates = Array.isArray(sc["pirates"])
				? (sc["pirates"] as Array<Record<string, unknown>>)
				: [];

			if (pirates.length === 0) {
				const message =
					ticksUsed > 0
						? `Cleared area after ${ticksUsed} attack(s)`
						: "Area clear, no pirates found";
				return succeeded(message, ticksUsed);
			}

			const state = ctx.refreshState ? await ctx.refreshState() : ctx.state;
			if ((state.ship?.hull ?? 1) <= 0) {
				return failed("Ship destroyed in combat", ticksUsed);
			}

			const target = pirates[0];
			if (!target) {
				return succeeded(`Cleared area after ${ticksUsed} attack(s)`, ticksUsed);
			}

			const pirateId = target["pirate_id"] as string;
			log.info(`Attacking pirate ${pirateId}`);
			await ctx.endpoints.attack(pirateId);
			ticksUsed++;
		}
	}
}

/**
 * Run a guard loop: patrol a POI, attack any pirates found, return home when
 * hull drops below repairThreshold OR fuel drops below fuelThreshold.
 *
 * Each iteration:
 * 1. If hull < repairThreshold OR fuel < fuelThreshold: PrepareAtStation — navigate home, dock, refuel, repair
 * 2. EnsureUndocked — no-op if already undocked
 * 3. NavigateToSystem — jump to guard system (no-op if already there)
 * 4. GoToPoi — travel to guard POI (no-op if already there)
 * 5. ClearPirates — attack all pirates until area is clear
 *
 * The ship stays at the guard POI between sweeps and returns home on damage
 * or low fuel. NavigateToSystem's pre-flight check provides a final guard
 * against departing with truly insufficient fuel.
 */
export async function runGuardLoop(
	options: GuardLoopOptions,
	ctx: GoalContext,
): Promise<LoopResult> {
	log.info(`Starting guard loop: home=${options.homeBaseId} → guard=${options.guardPoiId}`);

	const repairThreshold = (options.repairThreshold ?? 100) / 100;
	const fuelThreshold = (options.fuelThreshold ?? 0) / 100;

	const factory = (state: StoredGameState) => {
		const hull = state.ship?.hull ?? 0;
		const maxHull = state.ship?.max_hull ?? 1;
		const fuel = state.ship?.fuel ?? 0;
		const maxFuel = state.ship?.max_fuel ?? 1;
		const needsRepair = hull / maxHull < repairThreshold;
		const needsFuel = fuelThreshold > 0 && fuel / maxFuel < fuelThreshold;

		const steps: Goal[] = [];
		if (needsRepair || needsFuel) {
			if (needsFuel && !needsRepair) {
				log.info(
					`Low fuel (${fuel}/${maxFuel}, threshold ${Math.round(fuelThreshold * 100)}%), returning home to refuel`,
				);
			}
			steps.push(
				new PrepareAtStation({
					systemId: options.homeSystemId,
					poiId: options.homeStationPoiId,
					baseId: options.homeBaseId,
					...(options.cashSource !== undefined ? { cashSource: options.cashSource } : {}),
					...(options.minCredits !== undefined ? { minCredits: options.minCredits } : {}),
				}),
			);
		}
		steps.push(new EnsureUndocked());
		steps.push(new NavigateToSystem(options.guardSystemId));
		steps.push(new GoToPoi(options.guardPoiId));
		steps.push(new ClearPirates());

		return new SequenceGoal("guard-sweep", steps);
	};

	return runLoop(factory, ctx, options.loopOptions);
}
