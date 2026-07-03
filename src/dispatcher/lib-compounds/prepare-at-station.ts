import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult } from "../goals.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { LibDockAt } from "../lib-primitives/dock-at.js";
import { LibEnsureCreditsFromFaction } from "../lib-primitives/ensure-credits-from-faction.js";
import { LibEnsureFueled } from "../lib-primitives/ensure-fueled.js";
import { LibEnsureRepaired } from "../lib-primitives/ensure-repaired.js";
import { LibGoToPoi } from "../lib-primitives/go-to-poi.js";
import { LibNavigateToSystem } from "../lib-primitives/navigate-to-system.js";
import { LibNavigateViaRoute } from "../lib-primitives/navigate-via-route.js";
import { runLibSequence } from "../lib-sequence.js";

const log = createLogger("goal:prepare-at-station");

/** Options for the PrepareAtStation compound goal. */
export interface PrepareAtStationOptions {
	/** Target system ID to navigate to. */
	systemId: string;
	/** Target POI ID within the system (the station's POI). */
	poiId: string;
	/** Base ID to dock at. */
	baseId: string;
	/** Whether to refuel after docking. Defaults to true. */
	refuel?: boolean;
	/** Whether to repair after docking. Defaults to true. */
	repair?: boolean;
	/** When set to "faction", withdraws credits from the faction treasury if credits are low before refueling. */
	cashSource?: "faction";
	/** Minimum credit balance before withdrawing from faction storage. Defaults to 1000. */
	minCredits?: number;
	/**
	 * Explicit sequence of systems to jump through instead of letting
	 * find_route plan the path (e.g. to dodge patrols while smuggling).
	 * Must end at systemId. Jump failures fail the goal without re-planning.
	 */
	route?: string[];
	/**
	 * Fuel units the navigation step must keep in reserve beyond the route's
	 * estimated jump cost, so the ship arrives with a buffer (e.g. for the
	 * in-system hop to the station POI) rather than dry. Defaults to 0.
	 */
	fuelReserve?: number;
}

/**
 * Navigate to a station, dock, and optionally refuel and repair.
 *
 * This is the most common compound goal — it gets the ship into a
 * ready state at a specific station. Steps that are already satisfied
 * (e.g., already in the right system) are skipped without using ticks.
 *
 * Steps:
 * 1. NavigateToSystem — jump to the target system (multi-hop if needed)
 * 2. GoToPoi — travel to the station's POI within the system
 * 3. DockAt — dock at the station base
 * 4. EnsureFueled — refuel to max (if enabled)
 * 5. EnsureRepaired — repair hull to max (if enabled)
 */
export class LibPrepareAtStation implements LibGoal {
	readonly name = "prepare-at-station";
	private readonly options: PrepareAtStationOptions;

	constructor(options: PrepareAtStationOptions) {
		this.options = options;
	}

	async execute(ctx: LibGoalContext): Promise<CompoundGoalResult> {
		const route = this.options.route;
		if (route && route[route.length - 1] !== this.options.systemId) {
			return {
				success: false,
				message: `Explicit route must end at "${this.options.systemId}" (route ends at "${route[route.length - 1] ?? ""}")`,
				alreadySatisfied: false,
				ticksUsed: 0,
				steps: [],
			};
		}

		const fuelReserve = this.options.fuelReserve ?? 0;
		const steps: LibGoal[] = [
			route
				? new LibNavigateViaRoute(route, fuelReserve)
				: new LibNavigateToSystem(this.options.systemId, fuelReserve),
			new LibGoToPoi(this.options.poiId),
			new LibDockAt(this.options.baseId),
		];

		if (this.options.refuel !== false) {
			if (this.options.cashSource === "faction") {
				const creditsOpts =
					this.options.minCredits !== undefined
						? { minCredits: this.options.minCredits }
						: undefined;
				steps.push(new LibEnsureCreditsFromFaction(creditsOpts));
			}
			steps.push(new LibEnsureFueled());
		}

		if (this.options.repair !== false) {
			steps.push(new LibEnsureRepaired());
		}

		log.info(
			`Preparing at station: system=${this.options.systemId}, poi=${this.options.poiId}, base=${this.options.baseId}`,
		);

		return runLibSequence(steps, ctx);
	}
}
