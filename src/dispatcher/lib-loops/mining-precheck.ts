import { createLogger } from "../../util/logger.js";
import type { IterationResult, LoopResult } from "../goals.js";
import { LibPrepareAtStation } from "../lib-compounds/prepare-at-station.js";
import type { LibGoalContext } from "../lib-goal-context.js";

const log = createLogger("loop:mining");

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
 * Check whether the target mining POI requires a gas or ice harvester module,
 * and verify one is equipped.
 *
 * The belt's type is looked up from the faction's Intel database
 * (`query_intel`), the only way to learn about a POI the ship isn't at — the
 * game deliberately withholds remote POI/system info (get_poi/get_system report
 * only the current location). This runs at loop start, before travelling to the
 * belt, so a direct query wouldn't work.
 *
 * Returns null (don't block) when: no special module is required; the required
 * module is equipped; the faction has no intel facility or the target POI isn't
 * in the faction's intel yet (can't verify ahead of time — the run proceeds and
 * any wrong-harvester problem surfaces when mining is attempted); or module data
 * is unavailable in local state. If the POI is a gas_cloud or ice_field and the
 * required harvester is not equipped, navigates the ship to the sell station and
 * returns a failed LoopResult.
 */
export async function checkHarvesterForPoi(
	options: HarvesterPrecheckOptions,
	ctx: LibGoalContext,
): Promise<LoopResult | null> {
	let poiType: string | undefined;
	try {
		const intel = await ctx.account.commands.spacemolt_intel.query_intel({
			system_id: options.miningSystemId,
		});
		for (const entry of intel.structuredContent?.entries ?? []) {
			const poi = entry.pois?.find((p) => p.id === options.beltPoiId);
			if (poi) {
				poiType = poi.type;
				break;
			}
		}
	} catch (err) {
		// No intel facility, allied-only access, or any query failure — we can't
		// learn the belt type ahead of time, so don't block.
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

	let requiredPrefix: string;
	let typeName: string;

	if (poiType === "gas_cloud") {
		requiredPrefix = "gas_harvester_";
		typeName = "gas harvester";
	} else if (poiType === "ice_field") {
		requiredPrefix = "ice_harvester_";
		typeName = "ice harvester";
	} else {
		return null;
	}

	const state = await ctx.refreshState();
	if (!Array.isArray(state?.modules)) {
		log.warn(
			`Target POI ${options.beltPoiId} is a ${poiType} — module data unavailable, cannot verify harvester`,
		);
		return null;
	}

	const modules = state.modules as Array<Record<string, unknown>>;
	const hasRequired = modules.some(
		(m) => typeof m["type_id"] === "string" && (m["type_id"] as string).startsWith(requiredPrefix),
	);

	if (hasRequired) {
		return null;
	}

	log.warn(`Target POI is a ${poiType} but no ${typeName} is equipped — navigating to station`);

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
