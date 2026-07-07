import { CatalogCache, httpBaseFromWs } from "@spacemolt/lib";
import { createLogger } from "../../util/logger.js";
import type { IterationResult, LoopResult } from "../goals.js";
import { LibPrepareAtStation } from "../lib-compounds/prepare-at-station.js";
import type { LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("loop:mining");

// setpoint never overrides the game server's WS URL (see CLAUDE.md), so this
// matches @spacemolt/lib's own default for deriving the catalog's HTTP origin.
const GAME_HTTP_BASE_URL = httpBaseFromWs("wss://game.spacemolt.com/ws/v2");

let catalogPromise: Promise<CatalogCache> | undefined;

/** Fetches (and caches for the process lifetime) the static item catalog — resource extraction requirements don't change without a server release. */
function getCatalog(): Promise<CatalogCache> {
	catalogPromise ??= CatalogCache.load(GAME_HTTP_BASE_URL);
	return catalogPromise;
}

/** Test-only: clears the cached catalog so a test can control the next fetch. */
export function resetResourceCatalogForTests(): void {
	catalogPromise = undefined;
}

function harvesterModulePrefix(extractedBy: "gas" | "ice"): string {
	return extractedBy === "gas" ? "gas_harvester_" : "ice_harvester_";
}

export interface HarvesterPrecheckOptions {
	/** System containing the mining target (for the faction-intel lookup). */
	miningSystemId: string;
	/** POI ID of the mining target (belt, gas cloud, ice field). */
	beltPoiId: string;
	/** System containing the sell station (for navigation on failure). */
	sellSystemId: string;
	/** POI ID of the sell station. */
	sellStationPoiId: string;
	/** Base ID to dock at for selling. */
	sellBaseId: string;
}

/**
 * Check whether the ship can mine at least one resource at the target POI
 * with its currently equipped gear, and verify a gas/ice harvester is
 * equipped when nothing else there is minable.
 *
 * The gate is per-RESOURCE (each resource's `extracted_by` from the static
 * item catalog: "gas", "ice", or "mining"/anything else), not per-POI `type`.
 * A POI's `type` is an environmental/flavor label, not a resource
 * classification — e.g. one real POI is `type: gas_cloud` but its only
 * resources are fury_crystal and darksteel_ore, both `extracted_by: "mining"`
 * and minable with an ordinary mining laser. Gating on `type` alone
 * (`type === "gas_cloud"` ⇒ requires a gas harvester) incorrectly blocked
 * ore/crystal-rigged ships from POIs they could mine just fine. This mirrors
 * the server's own per-resource `canMineAny` gate (game engine, `mine`
 * handler) instead of assuming environment implies equipment.
 *
 * The belt's resources are looked up from the faction's Intel database
 * (`query_intel`), the only way to learn about a POI the ship isn't at — the
 * game deliberately withholds remote POI/system info (get_poi/get_system report
 * only the current location). This runs at loop start, before travelling to the
 * belt, so a direct query wouldn't work.
 *
 * Returns null (don't block) when: at least one resource at the POI is
 * minable with equipped gear; the faction has no intel facility or the target
 * POI isn't in the faction's intel yet; the POI has no resource data to judge
 * by; the item catalog can't be fetched; or module data is unavailable in
 * local state — in every uncertain case the run proceeds and any real
 * equipment problem surfaces when mining is attempted. Only blocks (navigates
 * to the sell station and returns a failed LoopResult) when every resource at
 * the POI needs a gas or ice harvester and none is equipped.
 */
export async function checkHarvesterForPoi(
	options: HarvesterPrecheckOptions,
	ctx: LibGoalContext,
): Promise<LoopResult | null> {
	let poiType: string | undefined;
	let resources: Array<{ resource_id: string }> | undefined;
	try {
		const intel = await ctx.account.commands.spacemolt_intel.query_intel({
			system_id: options.miningSystemId,
		});
		for (const entry of intel.structuredContent?.entries ?? []) {
			const poi = entry.pois?.find((p) => p.id === options.beltPoiId);
			if (poi) {
				poiType = poi.type;
				resources = poi.resources;
				break;
			}
		}
	} catch (err) {
		// No intel facility, allied-only access, or any query failure — we can't
		// learn the belt's resources ahead of time, so don't block.
		log.debug(
			`Intel lookup for ${options.beltPoiId} unavailable (${err instanceof Error ? err.message : String(err)}) — skipping harvester precheck`,
		);
		return null;
	}

	if (poiType === undefined) {
		// The POI isn't in the faction's intel yet — can't verify ahead of time.
		log.debug(`No faction intel on ${options.beltPoiId} yet — skipping harvester precheck`);
		return null;
	}

	if (!resources || resources.length === 0) {
		// No resource data to judge by — can't tell what's mineable, don't block.
		log.debug(
			`No resource data for ${options.beltPoiId} (${poiType}) — skipping harvester precheck`,
		);
		return null;
	}

	let catalog: CatalogCache;
	try {
		catalog = await getCatalog();
	} catch (err) {
		log.debug(
			`Item catalog unavailable (${err instanceof Error ? err.message : String(err)}) — skipping harvester precheck`,
		);
		return null;
	}

	const state = await ctx.refreshState();
	if (!Array.isArray(state?.modules)) {
		log.warn(
			`Target POI ${options.beltPoiId} (${poiType}) — module data unavailable, cannot verify harvester`,
		);
		return null;
	}

	const modules = state.modules as Array<Record<string, unknown>>;
	const hasModule = (prefix: string): boolean =>
		modules.some(
			(m) => typeof m["type_id"] === "string" && (m["type_id"] as string).startsWith(prefix),
		);

	const missingRequirements = new Set<string>();
	const canMineAny = resources.some((r) => {
		const extractedBy = catalog.item(r.resource_id)?.["extracted_by"];
		if (extractedBy === "gas" || extractedBy === "ice") {
			if (hasModule(harvesterModulePrefix(extractedBy))) return true;
			missingRequirements.add(`${extractedBy} harvester`);
			return false;
		}
		// "mining", "rad", or an uncatalogued resource — no precheck for these
		// (matches this function's pre-existing scope: only gas/ice harvesters).
		return true;
	});

	if (canMineAny) {
		return null;
	}

	const typeName = [...missingRequirements].join(" or ");
	log.warn(
		`Target POI ${options.beltPoiId} (${poiType}) has no resource minable with equipped gear — needs a ${typeName}`,
	);

	const iterations: IterationResult[] = [];
	let ticksUsed = 0;
	try {
		const prepareResult = await new LibPrepareAtStation({
			systemId: options.sellSystemId,
			poiId: options.sellStationPoiId,
			baseId: options.sellBaseId,
		}).execute(ctx);
		ticksUsed = prepareResult.ticksUsed;
	} catch (err) {
		// LibPrepareAtStation can throw if navigation fails in an unexpected way
		// (e.g. LibGoToPoi in a degraded state). The precheck result is still
		// failure — just without the benefit of having navigated to the sell
		// station first.
		log.warn(
			`Navigation to sell station failed during harvester precheck: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return {
		success: false,
		message: `${poiType} mining requires a ${typeName} but none is equipped`,
		alreadySatisfied: false,
		ticksUsed,
		iterations,
		iterationCount: 0,
	};
}
