import type { GameState } from "@spacemolt/lib";
import type { StoredGameState } from "../../state/store.js";
import { errorMessage } from "../../util/errors.js";
import { createLogger } from "../../util/logger.js";
import type { GoalResult, LoopOptions, LoopResult } from "../goals.js";
import { alreadySatisfied, failed, succeeded } from "../goals.js";
import { LibPrepareAtStation } from "../lib-compounds/prepare-at-station.js";
import type { LibGoal, LibGoalContext } from "../lib-goal-context.js";
import { type LibGoalFactory, runLibLoop } from "../lib-loops.js";
import { LibNavigateToSystem } from "../lib-primitives/navigate-to-system.js";
import { type MapSystem, bfsDistances, buildAdjacency } from "../route-graph.js";

const log = createLogger("loop:exploration");

/** Options for the exploration loop. */
export interface ExplorationLoopOptions {
	/** System containing the home station. */
	systemId: string;
	/** POI ID of the home station. */
	stationPoiId: string;
	/** Base ID to dock at. */
	baseId: string;
	/** Whether to explore lawless space in addition to home empire systems. Defaults to false. */
	allowLawless?: boolean;
	/** Minimum fuel units to keep as a buffer beyond the round-trip cost. Defaults to 10. */
	minFuelReserve?: number;
	/** Return home if hull / max_hull is below this threshold. Defaults to 0.5. */
	repairThreshold?: number;
	/** Whether to call survey_system after arriving in each new system. Defaults to false. */
	survey?: boolean;
	/**
	 * Treat intel entries with submitted_at_tick < this value as unvisited.
	 * Use this to re-explore systems whose intel is older than a given game tick
	 * (e.g. to capture newly-added resources or update survey data).
	 * If omitted, all existing intel entries are treated as visited.
	 */
	minSubmittedAtTick?: number;
	/** Loop control options (signal, maxIterations, shouldContinue). */
	loopOptions?: LoopOptions;
}

interface ExplorationIterationOptions {
	homeSystemId: string;
	homeStationPoiId: string;
	homeBaseId: string;
	homeEmpire: string;
	allowLawless: boolean;
	minFuelReserve: number;
	repairThreshold: number;
	survey: boolean;
	minSubmittedAtTick: number | undefined;
	/** Cached static map — fetched once at loop startup, reused each iteration. */
	cachedSystems: MapSystem[];
}

interface BfsTarget {
	systemId: string;
	hopsFromStart: number;
	hopsToHome: number;
}

/**
 * Find the nearest system in the static map that has not yet been recorded in the
 * faction intel database and passes the empire filter.
 *
 * The static map contains all systems in the universe with their connections and empire.
 * recordedSystemIds is the set of system_ids already in the intel database (from query_intel).
 * Returns null if all qualifying systems are already recorded.
 */
function bfsNearest(
	systems: MapSystem[],
	recordedSystemIds: Set<string>,
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
		if (systemId === startId) continue;
		if (recordedSystemIds.has(systemId)) continue;

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

/** A single exploration step: navigate to the nearest unrecorded system, returning home first if needed. */
class ExplorationIteration implements LibGoal {
	readonly name = "exploration-iteration";

	constructor(private readonly options: ExplorationIterationOptions) {}

	async execute(ctx: LibGoalContext): Promise<GoalResult> {
		const state = await ctx.refreshState();

		// Query intel database to see which systems are already recorded
		const intelResult = await ctx.account.commands.spacemolt_intel.query_intel();
		const minTick = this.options.minSubmittedAtTick;
		const recordedSystemIds = new Set(
			(intelResult.structuredContent?.entries ?? [])
				.filter((e) => minTick === undefined || e.submitted_at_tick >= minTick)
				.map((e) => e.system_id),
		);

		const currentSystemId = state.location?.system_id ?? this.options.homeSystemId;

		let target = bfsNearest(
			this.options.cachedSystems,
			recordedSystemIds,
			currentSystemId,
			this.options.homeSystemId,
			this.options.homeEmpire,
			this.options.allowLawless,
		);

		if (!target) {
			return alreadySatisfied("No unrecorded systems found in allowed area");
		}

		let ticksUsed = 0;
		const ship = state.ship;

		// find_route gives the actual fuel cost for this ship (accounts for ship class, speed, and fuel_efficiency skill)
		const routeResult = await ctx.account.commands.spacemolt.find_route({ id: target.systemId });
		const route = routeResult.structuredContent;
		const fuelPerJump = route?.fuel_per_jump ?? 0;
		const fuelNeeded =
			(route?.estimated_fuel ?? 0) + fuelPerJump * target.hopsToHome + this.options.minFuelReserve;
		const hull = ship?.hull ?? 0;
		const maxHull = ship?.max_hull ?? 1;
		const hullRatio = hull / maxHull;

		if ((ship?.fuel ?? 0) < fuelNeeded || hullRatio < this.options.repairThreshold) {
			log.info(
				`Returning home to refuel/repair: fuel=${ship?.fuel ?? 0} (need ${fuelNeeded}), hull=${Math.round(hullRatio * 100)}%`,
			);

			const prepResult = await new LibPrepareAtStation({
				systemId: this.options.homeSystemId,
				poiId: this.options.homeStationPoiId,
				baseId: this.options.homeBaseId,
				refuel: true,
				repair: true,
			}).execute(ctx);

			ticksUsed += prepResult.ticksUsed;

			if (!prepResult.success) {
				return {
					success: false,
					message: prepResult.message,
					alreadySatisfied: false,
					ticksUsed,
				};
			}

			// Re-query intel from home position; map is static so reuse cached copy
			const freshState = await ctx.refreshState();
			const freshIntelResult = await ctx.account.commands.spacemolt_intel.query_intel();
			const freshRecordedIds = new Set(
				(freshIntelResult.structuredContent?.entries ?? [])
					.filter((e) => minTick === undefined || e.submitted_at_tick >= minTick)
					.map((e) => e.system_id),
			);
			const homeSystemId = freshState.location?.system_id ?? this.options.homeSystemId;

			const newTarget = bfsNearest(
				this.options.cachedSystems,
				freshRecordedIds,
				homeSystemId,
				this.options.homeSystemId,
				this.options.homeEmpire,
				this.options.allowLawless,
			);

			if (!newTarget) {
				return {
					...alreadySatisfied("No unrecorded systems found after returning home"),
					ticksUsed,
				};
			}

			// Safety check: if even with full fuel we can't afford the trip, fail rather than loop.
			const freshShip = freshState.ship;
			const freshRouteResult = await ctx.account.commands.spacemolt.find_route({
				id: newTarget.systemId,
			});
			const freshRoute = freshRouteResult.structuredContent;
			const freshFuelPerJump = freshRoute?.fuel_per_jump ?? 0;
			const freshFuelNeeded =
				(freshRoute?.estimated_fuel ?? 0) +
				freshFuelPerJump * newTarget.hopsToHome +
				this.options.minFuelReserve;
			if ((freshShip?.fuel ?? 0) < freshFuelNeeded) {
				return failed(
					`Cannot reach nearest unrecorded system "${newTarget.systemId}": requires ${freshFuelNeeded} fuel, ship has ${freshShip?.fuel ?? 0}`,
					ticksUsed,
				);
			}

			target = newTarget;
		}

		log.info(
			`Navigating to unrecorded system ${target.systemId} (${target.hopsFromStart} hop(s) from current position)`,
		);
		const navResult = await new LibNavigateToSystem(target.systemId).execute(ctx);
		ticksUsed += navResult.ticksUsed;

		if (!navResult.success) {
			return { ...failed(navResult.message, 0), ticksUsed };
		}

		if (this.options.survey) {
			log.info(`Surveying system ${target.systemId}`);
			await ctx.account.commands.spacemolt.survey_system();
			ticksUsed++;
		}

		return succeeded(
			`Recorded ${target.systemId} in faction intel (${target.hopsFromStart} hop(s) from start)`,
			ticksUsed,
		);
	}
}

/**
 * Run an exploration loop: navigate to the nearest system not yet in the faction intel
 * database each iteration.
 *
 * Each iteration:
 * 1. Queries the intel database (query_intel) to see what's already recorded
 * 2. Fetches the static navigation map (get_map) to see all systems and their connections
 * 3. BFS from current position to find the nearest unrecorded system matching the empire filter
 * 4. If fuel is insufficient for the round trip, returns home to PrepareAtStation first
 * 5. Navigates to the target system (NavigateToSystem handles multi-hop routes)
 *    Visiting the system automatically records it via the Level 2 Intel Center.
 *
 * The loop terminates when all qualifying systems have been recorded, or when stopped/cancelled.
 *
 * Requires the faction to have a Level 2 Intel Center (intel_level >= 2). This is
 * checked upfront and the loop fails immediately if the requirement is not met.
 */
export async function runExplorationLoop(
	options: ExplorationLoopOptions,
	ctx: LibGoalContext,
): Promise<LoopResult> {
	const minFuelReserve = options.minFuelReserve ?? 10;
	const repairThreshold = options.repairThreshold ?? 0.5;
	const allowLawless = options.allowLawless ?? false;
	const survey = options.survey ?? false;

	// Upfront: verify faction has Level 2 Intel Center
	log.info("Checking faction intel level...");
	let intelLevel = 0;
	try {
		const intelResult = await ctx.account.commands.spacemolt_intel.intel_status();
		intelLevel = intelResult.structuredContent?.intel_level ?? 0;
	} catch (err) {
		const msg = errorMessage(err);
		return {
			success: false,
			message: `Failed to check intel status: ${msg}`,
			alreadySatisfied: false,
			ticksUsed: 0,
			iterations: [],
			iterationCount: 0,
		};
	}

	if (intelLevel < 2) {
		return {
			success: false,
			message: `Faction requires a Level 2 Intel Center for exploration (current level: ${intelLevel})`,
			alreadySatisfied: false,
			ticksUsed: 0,
			iterations: [],
			iterationCount: 0,
		};
	}

	// Upfront: fetch the static map once — it's the same for all players, no need to re-fetch
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
		const homeSystem = cachedSystems.find((s) => s.system_id === options.systemId);
		if (!homeSystem) {
			return {
				success: false,
				message: `Home system "${options.systemId}" not found in map`,
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
		`Starting exploration loop: home=${options.systemId} (${homeEmpire || "lawless"}), allowLawless=${allowLawless}`,
	);

	const iterationOptions: ExplorationIterationOptions = {
		homeSystemId: options.systemId,
		homeStationPoiId: options.stationPoiId,
		homeBaseId: options.baseId,
		homeEmpire,
		allowLawless,
		minFuelReserve,
		repairThreshold,
		survey,
		minSubmittedAtTick: options.minSubmittedAtTick,
		cachedSystems,
	};

	const factory: LibGoalFactory = (_state: Readonly<GameState>): LibGoal =>
		new ExplorationIteration(iterationOptions);

	// Stop the loop when the last iteration returned alreadySatisfied (no more systems to record).
	let lastResult: GoalResult | undefined;

	// shouldContinue is typed against StoredGameState in the shared LoopOptions
	// (see runLibLoop's cast comment) — this loop doesn't read state fields, so
	// the type only matters for satisfying the shared signature.
	const shouldContinue = (_iteration: number, _state: StoredGameState): boolean => {
		if (lastResult?.alreadySatisfied) {
			return false;
		}
		return true;
	};

	const onIterationComplete = (iteration: number, result: GoalResult): void => {
		lastResult = result;
		options.loopOptions?.onIterationComplete?.(iteration, result);
	};

	return runLibLoop(factory, ctx, {
		...options.loopOptions,
		shouldContinue: options.loopOptions?.shouldContinue ?? shouldContinue,
		onIterationComplete,
	});
}
