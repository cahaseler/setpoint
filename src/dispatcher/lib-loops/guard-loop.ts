import type { GameState } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { GoalResult, LoopOptions, LoopResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import { LibPrepareAtStation } from "../lib-compounds/prepare-at-station.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { type LibGoalFactory, runLibLoop } from "../lib-loops.js";
import { LibEnsureUndocked } from "../lib-primitives/ensure-undocked.js";
import { LibGoToPoi } from "../lib-primitives/go-to-poi.js";
import { LibNavigateToSystem } from "../lib-primitives/navigate-to-system.js";
import { runLibSequence } from "../lib-sequence.js";

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
	/**
	 * How the fight itself is flown once pirates are found.
	 *
	 * `"auto"` (the default) repeats `attack` until the area is clear.
	 * `"external"` opens the battle and stops, leaving it to combat logic
	 * running outside setpoint — pair it with combat mode `"external"` so the
	 * built-in flee response does not take the ship back. Combat entry releases
	 * the account from this loop either way, so continuing to attack would mean
	 * two things flying one ship.
	 */
	engagement?: "auto" | "external";
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
class LibClearPirates implements LibGoal {
	readonly name = "clear-pirates";

	constructor(private readonly engagement: "auto" | "external" = "auto") {}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		let ticksUsed = 0;

		for (;;) {
			// Check for external cancellation between attacks — combat is unbounded,
			// and a force abort must not wait for the area to clear.
			if (ctx.signal?.aborted) {
				return failed(`Combat aborted after ${ticksUsed} attack(s)`, ticksUsed);
			}

			const nearbyResp = await ctx.account.commands.spacemolt.get_nearby();
			const pirates = nearbyResp.structuredContent?.pirates ?? [];

			if (pirates.length === 0) {
				const message =
					ticksUsed > 0
						? `Cleared area after ${ticksUsed} attack(s)`
						: "Area clear, no pirates found";
				return succeeded(message, ticksUsed);
			}

			const state = await ctx.refreshState();
			if ((state.ship?.hull ?? 1) <= 0) {
				return failed("Ship destroyed in combat", ticksUsed);
			}

			const target = pirates[0];
			if (!target) {
				return succeeded(`Cleared area after ${ticksUsed} attack(s)`, ticksUsed);
			}

			log.info(`Attacking pirate ${target.pirate_id}`);
			await ctx.account.commands.spacemolt.attack({ id: target.pirate_id });
			ticksUsed++;

			if (this.engagement === "external") {
				// Hand the fight over: the opening attack starts the battle, and
				// combat entry releases this account from the loop anyway, so
				// carrying on would just be setpoint and the external driver both
				// flying the same ship. Whoever is driving takes it from here.
				return succeeded(
					`Opened combat with ${target.pirate_id} and handed off to the external driver`,
					ticksUsed,
				);
			}
		}
	}
}

/**
 * Run a guard loop: patrol a POI, attack any pirates found, return home when
 * hull drops below repairThreshold OR fuel drops below fuelThreshold.
 *
 * Each iteration:
 * 1. If hull < repairThreshold OR fuel < fuelThreshold: LibPrepareAtStation — navigate home, dock, refuel, repair
 * 2. LibEnsureUndocked — no-op if already undocked
 * 3. LibNavigateToSystem — jump to guard system (no-op if already there)
 * 4. LibGoToPoi — travel to guard POI (no-op if already there)
 * 5. LibClearPirates — attack all pirates until area is clear
 *
 * The ship stays at the guard POI between sweeps and returns home on damage
 * or low fuel. LibNavigateToSystem's pre-flight check provides a final guard
 * against departing with truly insufficient fuel.
 */
export async function runGuardLoop(
	options: GuardLoopOptions,
	ctx: LibGoalContext,
): Promise<LoopResult> {
	log.info(`Starting guard loop: home=${options.homeBaseId} → guard=${options.guardPoiId}`);

	const repairThreshold = (options.repairThreshold ?? 100) / 100;
	const fuelThreshold = (options.fuelThreshold ?? 0) / 100;

	const factory: LibGoalFactory = (state: Readonly<GameState>): LibGoal => {
		const hull = state.ship?.hull ?? 0;
		const maxHull = state.ship?.max_hull ?? 1;
		const fuel = state.ship?.fuel ?? 0;
		const maxFuel = state.ship?.max_fuel ?? 1;
		const needsRepair = hull / maxHull < repairThreshold;
		const needsFuel = fuelThreshold > 0 && fuel / maxFuel < fuelThreshold;

		const steps: LibGoal[] = [];
		if (needsRepair || needsFuel) {
			if (needsFuel && !needsRepair) {
				log.info(
					`Low fuel (${fuel}/${maxFuel}, threshold ${Math.round(fuelThreshold * 100)}%), returning home to refuel`,
				);
			}
			steps.push(
				new LibPrepareAtStation({
					systemId: options.homeSystemId,
					poiId: options.homeStationPoiId,
					baseId: options.homeBaseId,
					...(options.cashSource !== undefined ? { cashSource: options.cashSource } : {}),
					...(options.minCredits !== undefined ? { minCredits: options.minCredits } : {}),
				}),
			);
		}
		steps.push(new LibEnsureUndocked());
		steps.push(new LibNavigateToSystem(options.guardSystemId));
		steps.push(new LibGoToPoi(options.guardPoiId));
		steps.push(new LibClearPirates(options.engagement ?? "auto"));

		return {
			name: "guard-sweep",
			execute: (stepCtx) => runLibSequence(steps, stepCtx),
		};
	};

	return runLibLoop(factory, ctx, options.loopOptions);
}
