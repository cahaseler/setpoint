import type { GameState } from "@spacemolt/lib";
import { errorMessage } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { GoalResult, LoopOptions, LoopResult } from "../goals.js";
import { failed, succeeded } from "../goals.js";
import { LibLootUntilFull } from "../lib-compounds/loot-until-full.js";
import { LibPrepareAtStation } from "../lib-compounds/prepare-at-station.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { type LibGoalFactory, runLibLoop } from "../lib-loops.js";
import { LibEnsureEmptyCargo } from "../lib-primitives/ensure-empty-cargo.js";
import { LibEnsureUndocked } from "../lib-primitives/ensure-undocked.js";
import { LibGoToPoi } from "../lib-primitives/go-to-poi.js";
import { LibNavigateToSystem } from "../lib-primitives/navigate-to-system.js";
import { type MapSystem, bfsDistances, buildAdjacency } from "../route-graph.js";

const log = createLogger("loop:roaming-salvage");

/** Options for the roaming salvage loop. */
export interface RoamingSalvageLoopOptions {
	/** System containing the home station. */
	homeSystemId: string;
	/** POI ID of the home station. */
	homeStationPoiId: string;
	/** Base ID to dock at for deposits. */
	homeBaseId: string;
	/** Whether to visit lawless systems in addition to home empire systems. Defaults to false. */
	allowLawless?: boolean;
	/** Cargo fill fraction that triggers returning home. Defaults to 1.0. */
	fullThreshold?: number;
	/** Minimum fuel units to keep as a buffer beyond the estimated return cost. Defaults to 10. */
	minFuelReserve?: number;
	/** Whether to repair hull when returning home. Defaults to true. */
	repair?: boolean;
	/** Where to deposit looted cargo. Defaults to "personal". */
	depositTarget?: "personal" | "faction";
	/** When set to "faction", withdraws credits from the faction treasury if credits are low before refueling. */
	cashSource?: "faction";
	/** Minimum credit balance before withdrawing from storage. */
	minCredits?: number;
	/** Maximum loot attempts per wreck site. Passed to LootUntilFull. */
	maxLootAttempts?: number;
	/** Loop control options (signal, maxIterations, shouldContinue). */
	loopOptions?: LoopOptions;
}

interface RoamingSalvageIterationOptions {
	homeSystemId: string;
	homeStationPoiId: string;
	homeBaseId: string;
	homeEmpire: string;
	allowLawless: boolean;
	fullThreshold: number;
	minFuelReserve: number;
	repair: boolean;
	depositTarget: "personal" | "faction";
	cashSource: "faction" | undefined;
	minCredits: number | undefined;
	maxLootAttempts: number | undefined;
	cachedSystems: MapSystem[];
	/** Mutable sweep state shared across iterations. */
	sweepState: RoamingSalvageSweepState;
}

/** Mutable state shared across all iterations of a single loop run. */
interface RoamingSalvageSweepState {
	/** Systems fully visited in the current sweep. Resets when all systems are done. */
	visitedSystemsThisSweep: Set<string>;
	/** System currently being worked through. Null when between systems. */
	currentSystemId: string | null;
	/**
	 * POI IDs not yet visited in the current system.
	 * When empty and currentSystemId is set, the system is done.
	 */
	remainingPoisInCurrentSystem: string[];
}

interface BfsTarget {
	systemId: string;
	hopsFromStart: number;
	hopsToHome: number;
}

/**
 * Find the nearest unvisited system in the static map that passes the empire filter.
 *
 * visitedIds contains systems already visited this sweep. Returns null when all
 * qualifying systems have been visited.
 */
function bfsNearest(
	systems: MapSystem[],
	visitedIds: Set<string>,
	startId: string,
	homeSystemId: string,
	homeEmpire: string,
	allowLawless: boolean,
): BfsTarget | null {
	const adjacency = buildAdjacency(systems);
	const systemMap = new Map<string, MapSystem>();
	for (const system of systems) {
		systemMap.set(system.system_id, system);
	}

	const distFromStart = bfsDistances(adjacency, startId);
	const distFromHome = bfsDistances(adjacency, homeSystemId);

	let best: BfsTarget | null = null;

	for (const [systemId, hopsFromStart] of distFromStart) {
		if (systemId === homeSystemId) continue;
		if (visitedIds.has(systemId)) continue;

		const system = systemMap.get(systemId);
		if (!system) continue;

		const empire = system.empire ?? "";
		const inHomeEmpire = empire === homeEmpire;
		const isLawless = empire === "";
		if (!inHomeEmpire && !(allowLawless && isLawless)) continue;

		const hopsToHome = distFromHome.get(systemId) ?? Number.POSITIVE_INFINITY;

		if (best === null || hopsFromStart < best.hopsFromStart) {
			best = { systemId, hopsFromStart, hopsToHome };
		}
	}

	return best;
}

/** A single roaming salvage iteration: either visit a POI, navigate to a new system, or return home. */
class RoamingSalvageIteration implements LibGoal {
	readonly name = "roaming-salvage-iteration";

	constructor(private readonly options: RoamingSalvageIterationOptions) {}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		const state = await ctx.refreshState();
		const ship = state.ship;

		// Check if cargo is full — return home to deposit before continuing.
		const capacity = ship?.cargo_capacity ?? 0;
		const cargoFull =
			ship !== undefined &&
			capacity > 0 &&
			(ship.cargo_used ?? 0) / capacity >= this.options.fullThreshold;

		if (cargoFull) {
			log.info(
				`Cargo full (${ship?.cargo_used ?? 0}/${ship?.cargo_capacity ?? 0}), returning home to deposit`,
			);
			return this.returnHome(ctx, 0);
		}

		if (this.options.sweepState.remainingPoisInCurrentSystem.length > 0) {
			// Visit the next POI in the current system.
			return this.visitNextPoi(ctx, state, ship?.fuel ?? 0);
		}

		// Current system is done — mark it visited and find the next system.
		return this.advanceToNextSystem(ctx, state, ship?.fuel ?? 0);
	}

	private async visitNextPoi(
		ctx: LibGoalContext,
		state: Readonly<GameState>,
		currentFuel: number,
	): Promise<GoalResult> {
		// Check fuel: can we return home from the current system after this visit?
		const homeRouteResult = await ctx.account.commands.spacemolt.find_route({
			id: this.options.homeSystemId,
		});
		const homeRoute = homeRouteResult.structuredContent;
		const fuelToReturn = (homeRoute?.estimated_fuel ?? 0) + this.options.minFuelReserve;

		if (currentFuel < fuelToReturn) {
			log.info(
				`Low fuel (${currentFuel} < ${fuelToReturn} needed to return home), returning to refuel`,
			);
			return this.returnHome(ctx, 0);
		}

		// Navigate to the current system if we're not already there (e.g., after returning home).
		const currentSystemId = this.options.sweepState.currentSystemId;
		if (!currentSystemId) {
			return failed("No current system set despite remaining POIs", 0);
		}

		let ticksUsed = 0;
		const currentLocation = state.location?.system_id;

		if (currentLocation !== currentSystemId) {
			log.info(`Navigating back to ${currentSystemId} to resume POI sweep`);
			const navResult = await new LibNavigateToSystem(currentSystemId).execute(ctx);
			ticksUsed += navResult.ticksUsed;
			if (!navResult.success) {
				return { success: false, message: navResult.message, alreadySatisfied: false, ticksUsed };
			}
		}

		// Pop the next POI — length > 0 was checked by the caller.
		const poiId = this.options.sweepState.remainingPoisInCurrentSystem.shift();
		if (poiId === undefined) {
			// Shouldn't happen after the length check, but TypeScript requires this guard.
			return failed("No remaining POIs after shift", 0);
		}

		log.info(
			`Visiting POI ${poiId} in system ${currentSystemId} (${this.options.sweepState.remainingPoisInCurrentSystem.length} remaining after this)`,
		);

		// Travel to the POI.
		const poiResult = await new LibGoToPoi(poiId).execute(ctx);
		ticksUsed += poiResult.ticksUsed;
		if (!poiResult.success) {
			return { success: false, message: poiResult.message, alreadySatisfied: false, ticksUsed };
		}

		// Ensure undocked before looting.
		const undockResult = await new LibEnsureUndocked().execute(ctx);
		ticksUsed += undockResult.ticksUsed;
		if (!undockResult.success) {
			return {
				success: false,
				message: undockResult.message,
				alreadySatisfied: false,
				ticksUsed,
			};
		}

		// Loot all wrecks at this POI — need fresh state after travel.
		await ctx.refreshState();
		const lootResult = await new LibLootUntilFull({
			...(this.options.maxLootAttempts !== undefined
				? { maxAttempts: this.options.maxLootAttempts }
				: {}),
		}).execute(ctx);
		ticksUsed += lootResult.ticksUsed;

		if (!lootResult.success) {
			return {
				success: false,
				message: `Loot failed at ${poiId}: ${lootResult.message}`,
				alreadySatisfied: false,
				ticksUsed,
			};
		}

		return succeeded(
			`Visited POI ${poiId} in ${currentSystemId}: ${lootResult.message}`,
			ticksUsed,
		);
	}

	private async advanceToNextSystem(
		ctx: LibGoalContext,
		state: Readonly<GameState>,
		currentFuel: number,
	): Promise<GoalResult> {
		const sw = this.options.sweepState;

		// Mark the current system as visited if there was one.
		if (sw.currentSystemId !== null) {
			log.info(`Finished system ${sw.currentSystemId}, marking as visited`);
			sw.visitedSystemsThisSweep.add(sw.currentSystemId);
			sw.currentSystemId = null;
		}

		const currentSystemId = state.location?.system_id ?? this.options.homeSystemId;

		const target = bfsNearest(
			this.options.cachedSystems,
			sw.visitedSystemsThisSweep,
			currentSystemId,
			this.options.homeSystemId,
			this.options.homeEmpire,
			this.options.allowLawless,
		);

		if (!target) {
			// All qualifying systems have been visited — reset and restart the sweep.
			log.info(
				`All qualifying systems visited. Resetting sweep (${sw.visitedSystemsThisSweep.size} system(s) covered).`,
			);
			sw.visitedSystemsThisSweep = new Set<string>();
			sw.remainingPoisInCurrentSystem = [];
			return succeeded(
				`Sweep complete — visited ${sw.visitedSystemsThisSweep.size === 0 ? "all qualifying" : "all"} systems, restarting`,
				0,
			);
		}

		// Check fuel: enough to reach target + return home?
		const routeResult = await ctx.account.commands.spacemolt.find_route({ id: target.systemId });
		const route = routeResult.structuredContent;
		const fuelNeeded =
			(route?.estimated_fuel ?? 0) +
			(route?.fuel_per_jump ?? 0) * target.hopsToHome +
			this.options.minFuelReserve;

		if (currentFuel < fuelNeeded) {
			log.info(
				`Insufficient fuel for round trip to ${target.systemId} (have ${currentFuel}, need ${fuelNeeded}), returning home`,
			);
			return this.returnHome(ctx, 0);
		}

		// Navigate to the new system.
		log.info(
			`Navigating to system ${target.systemId} (${target.hopsFromStart} hop(s) from current position)`,
		);
		const navResult = await new LibNavigateToSystem(target.systemId).execute(ctx);
		if (!navResult.success) {
			return navResult;
		}

		// Fetch the system's POI list. Skip POIs with a base (station) — no wrecks spawn there.
		// lib codegen gap: get_system() takes no system-id parameter (unlike the old REST
		// getSystem(systemId) call, which fetched an arbitrary system's info). This is not
		// a problem here: LibNavigateToSystem above just succeeded, so the ship is already
		// in target.systemId — get_system() with no argument returns exactly that system.
		const systemResult = await ctx.account.commands.spacemolt.get_system();
		const content = systemResult.structuredContent;
		if (!content || !("system" in content)) {
			return failed(
				`System response for ${target.systemId} indicates in-transit, cannot list POIs`,
				0,
			);
		}
		const allPois = content.system.pois;
		const salvagePois = allPois.filter((poi) => !poi.has_base);

		log.info(
			`Arrived at ${target.systemId}: ${salvagePois.length} salvageable POI(s) of ${allPois.length} total`,
		);

		sw.currentSystemId = target.systemId;
		sw.remainingPoisInCurrentSystem = salvagePois.map((poi) => poi.id);

		return succeeded(
			`Arrived at ${target.systemId}, found ${salvagePois.length} salvageable POI(s)`,
			navResult.ticksUsed,
		);
	}

	/** Return to the home station, deposit cargo, refuel, repair, and undock. */
	private async returnHome(ctx: LibGoalContext, initialTicks: number): Promise<GoalResult> {
		log.info(`Returning home to ${this.options.homeSystemId} to deposit/refuel`);
		let ticksUsed = initialTicks;

		const prepResult = await new LibPrepareAtStation({
			systemId: this.options.homeSystemId,
			poiId: this.options.homeStationPoiId,
			baseId: this.options.homeBaseId,
			refuel: true,
			repair: this.options.repair,
			...(this.options.cashSource !== undefined ? { cashSource: this.options.cashSource } : {}),
			...(this.options.minCredits !== undefined ? { minCredits: this.options.minCredits } : {}),
		}).execute(ctx);
		ticksUsed += prepResult.ticksUsed;
		if (!prepResult.success) {
			return { success: false, message: prepResult.message, alreadySatisfied: false, ticksUsed };
		}

		// Refresh state so EnsureEmptyCargo and EnsureUndocked see the docked status
		// set by PrepareAtStation rather than the stale start-of-iteration snapshot.
		await ctx.refreshState();

		const emptyResult = await new LibEnsureEmptyCargo({
			...(this.options.depositTarget !== "personal"
				? { depositTarget: this.options.depositTarget }
				: {}),
		}).execute(ctx);
		ticksUsed += emptyResult.ticksUsed;
		if (!emptyResult.success) {
			return {
				success: false,
				message: emptyResult.message,
				alreadySatisfied: false,
				ticksUsed,
			};
		}

		const undockResult = await new LibEnsureUndocked().execute(ctx);
		ticksUsed += undockResult.ticksUsed;
		if (!undockResult.success) {
			return {
				success: false,
				message: undockResult.message,
				alreadySatisfied: false,
				ticksUsed,
			};
		}

		return succeeded("Returned home, deposited cargo, ready to resume sweep", ticksUsed);
	}
}

/**
 * Run a roaming salvage loop: sweep through all empire systems using BFS, visiting every
 * salvageable POI in each system to loot wrecks. Returns home to deposit cargo and refuel
 * when cargo is full or fuel is low. Restarts the sweep when all qualifying systems are visited.
 *
 * Each iteration does exactly one atomic task:
 * - If cargo full → return home (PrepareAtStation + EnsureEmptyCargo + EnsureUndocked)
 * - If remaining POIs in current system → visit next POI (GoToPoi + LootUntilFull)
 * - If current system done → find next system via BFS, navigate to it, load its POI list
 * - If all systems done → reset sweep and return (loop restarts from beginning)
 *
 * Station POIs (has_base: true) are skipped — wrecks do not spawn at stations.
 * The sweep state (visited systems, remaining POIs) persists across return-home trips,
 * so the loop resumes exactly where it left off after refueling.
 */
export async function runRoamingSalvageLoop(
	options: RoamingSalvageLoopOptions,
	ctx: LibGoalContext,
): Promise<LoopResult> {
	const fullThreshold = options.fullThreshold ?? 1.0;
	const minFuelReserve = options.minFuelReserve ?? 10;
	const repair = options.repair ?? true;
	const allowLawless = options.allowLawless ?? false;
	const depositTarget = options.depositTarget ?? "personal";

	// Upfront: fetch the static map once — it's the same for all players, no need to re-fetch.
	log.info("Fetching static map...");
	let cachedSystems: MapSystem[] = [];
	let homeEmpire = "";

	try {
		const mapResult = await ctx.account.commands.spacemolt.get_map();
		const mapContent = mapResult.structuredContent;
		if (!mapContent || !("systems" in mapContent)) {
			return {
				success: false,
				message: "get_map did not return a systems list",
				alreadySatisfied: false,
				ticksUsed: 0,
				iterations: [],
				iterationCount: 0,
			};
		}
		cachedSystems = mapContent.systems;
		const homeSystem = cachedSystems.find((s) => s.system_id === options.homeSystemId);
		if (!homeSystem) {
			return {
				success: false,
				message: `Home system "${options.homeSystemId}" not found in map`,
				alreadySatisfied: false,
				ticksUsed: 0,
				iterations: [],
				iterationCount: 0,
			};
		}
		homeEmpire = homeSystem.empire ?? "";
	} catch (err) {
		const msg = errorMessage(err);
		return {
			success: false,
			message: `Failed to fetch map: ${msg}`,
			alreadySatisfied: false,
			ticksUsed: 0,
			iterations: [],
			iterationCount: 0,
		};
	}

	log.info(
		`Starting roaming salvage loop: home=${options.homeSystemId} (${homeEmpire || "lawless"}), allowLawless=${allowLawless}`,
	);

	// Mutable sweep state shared across all iterations via a single object reference.
	const sweepState: RoamingSalvageSweepState = {
		visitedSystemsThisSweep: new Set<string>(),
		currentSystemId: null,
		remainingPoisInCurrentSystem: [],
	};

	const iterationOptions: RoamingSalvageIterationOptions = {
		homeSystemId: options.homeSystemId,
		homeStationPoiId: options.homeStationPoiId,
		homeBaseId: options.homeBaseId,
		homeEmpire,
		allowLawless,
		fullThreshold,
		minFuelReserve,
		repair,
		depositTarget,
		cashSource: options.cashSource,
		minCredits: options.minCredits,
		maxLootAttempts: options.maxLootAttempts,
		cachedSystems,
		sweepState,
	};

	const factory: LibGoalFactory = (_state: Readonly<GameState>): LibGoal =>
		new RoamingSalvageIteration(iterationOptions);

	return runLibLoop(factory, ctx, options.loopOptions);
}
