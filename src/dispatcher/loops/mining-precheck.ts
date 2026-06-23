import { createLogger } from "../../util/logger.js";
import { PrepareAtStation } from "../compounds/prepare-at-station.js";
import type { GoalContext, IterationResult, LoopResult } from "../goals.js";

const log = createLogger("loop:mining");

export interface HarvesterPrecheckOptions {
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
 * Returns null if no special module is required or if the required module is
 * equipped. If the POI is a gas_cloud or ice_field and the required harvester
 * is not equipped, navigates the ship to the sell station and returns a failed
 * LoopResult.
 *
 * If module data is unavailable in local state, the check is skipped.
 */
export async function checkHarvesterForPoi(
	options: HarvesterPrecheckOptions,
	ctx: GoalContext,
): Promise<LoopResult | null> {
	const poiResponse = await ctx.endpoints.getPoi(options.beltPoiId);
	const poi = poiResponse.structuredContent["poi"];
	const poiType =
		typeof poi === "object" && poi !== null ? (poi as Record<string, unknown>)["type"] : undefined;

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

	const state = ctx.refreshState ? await ctx.refreshState() : ctx.state;
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
		const prepareResult = await new PrepareAtStation({
			systemId: options.sellSystemId,
			poiId: options.sellStationPoiId,
			baseId: options.sellBaseId,
		}).execute(ctx);
		ticksUsed = prepareResult.ticksUsed;
	} catch (err) {
		// PrepareAtStation can throw if navigation fails in an unexpected way (e.g.
		// GoToPoi in a degraded state). The precheck result is still failure — just
		// without the benefit of having navigated to the sell station first.
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
