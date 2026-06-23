import { createLogger } from "../../util/logger.js";
import type { CompoundGoalResult, Goal, GoalContext } from "../goals.js";
import {
	DockAt,
	EnsureCreditsFromFaction,
	EnsureFueled,
	EnsureRepaired,
	GoToPoi,
	NavigateToSystem,
	NavigateViaRoute,
} from "../primitives/index.js";
import { runSequence } from "../sequence.js";

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
export class PrepareAtStation implements Goal {
	readonly name = "prepare-at-station";
	private readonly options: PrepareAtStationOptions;

	constructor(options: PrepareAtStationOptions) {
		this.options = options;
	}

	async execute(ctx: GoalContext): Promise<CompoundGoalResult> {
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

		const steps: Goal[] = [
			route ? new NavigateViaRoute(route) : new NavigateToSystem(this.options.systemId),
			new GoToPoi(this.options.poiId),
			new DockAt(this.options.baseId),
		];

		if (this.options.refuel !== false) {
			if (this.options.cashSource === "faction") {
				const creditsOpts =
					this.options.minCredits !== undefined
						? { minCredits: this.options.minCredits }
						: undefined;
				steps.push(new EnsureCreditsFromFaction(creditsOpts));
			}
			steps.push(new EnsureFueled());
		}

		if (this.options.repair !== false) {
			steps.push(new EnsureRepaired());
		}

		log.info(
			`Preparing at station: system=${this.options.systemId}, poi=${this.options.poiId}, base=${this.options.baseId}`,
		);

		return runSequence(steps, ctx);
	}
}
