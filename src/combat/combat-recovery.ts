/**
 * Resolves and runs the post-combat "get the ship somewhere safe and stop"
 * recovery step, invoked by `CombatReactor` once a flee attempt succeeds.
 * Recovery never resumes the interrupted loop — it only gets the ship
 * docked; the operator or their automation decides what to run next.
 */

import type { GoalResult } from "../dispatcher/goals.js";
import { LibPrepareAtStation } from "../dispatcher/lib-compounds/prepare-at-station.js";
import type { LibGoalContext } from "../dispatcher/lib-goal-context.js";
import { type MapSystem, hopDistance } from "../dispatcher/route-graph.js";

export interface RecoveryTarget {
	systemId: string;
	poiId: string;
	baseId: string;
}

/** Current position + the static map, needed only to compare hauling's two candidate legs by hop distance. */
export interface RecoveryProximity {
	currentSystemId: string;
	systems: MapSystem[];
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

/** Reads {systemId, poiId, baseId} off a hauling loop's `source`/`destination` sub-object, if all three are present. */
function readLeg(value: unknown): RecoveryTarget | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const systemId = asString(record["systemId"]);
	const poiId = asString(record["poiId"]);
	const baseId = asString(record["baseId"]);
	if (!systemId || !poiId || !baseId) return undefined;
	return { systemId, poiId, baseId };
}

/**
 * Decides where to send the ship after combat resolves, based on the
 * snapshot of the interrupted loop's type + options taken before it was
 * force-released.
 *
 * - `mining` / `enhanced-mining` → the loop's own sell station (its only
 *   defined "safe" target — no comparison needed).
 * - `hauling` → whichever of `source`/`destination` is fewer hops away from
 *   the ship's current position. Falls back to `source` when proximity data
 *   is unavailable, or when neither leg is reachable in the map.
 * - Any other loop type, or missing/incomplete option fields → `undefined`,
 *   meaning "no built-in recovery" (matches `combatRecovery: "external"`/
 *   `"none"` semantics — the caller records only the interruption itself).
 */
export function resolveRecoveryTarget(
	loopType: string | undefined,
	loopOptions: Record<string, unknown> | undefined,
	proximity?: RecoveryProximity,
): RecoveryTarget | undefined {
	if (!loopOptions) return undefined;

	if (loopType === "mining" || loopType === "enhanced-mining") {
		const systemId = asString(loopOptions["sellSystemId"]);
		const poiId = asString(loopOptions["sellStationPoiId"]);
		const baseId = asString(loopOptions["sellBaseId"]);
		if (!systemId || !poiId || !baseId) return undefined;
		return { systemId, poiId, baseId };
	}

	if (loopType === "hauling") {
		const source = readLeg(loopOptions["source"]);
		const destination = readLeg(loopOptions["destination"]);
		if (!source) return destination;
		if (!destination || !proximity) return source;

		const distToSource = hopDistance(proximity.systems, proximity.currentSystemId, source.systemId);
		const distToDestination = hopDistance(
			proximity.systems,
			proximity.currentSystemId,
			destination.systemId,
		);
		if (
			distToDestination !== undefined &&
			(distToSource === undefined || distToDestination < distToSource)
		) {
			return destination;
		}
		return source;
	}

	return undefined;
}

/** Runs the recovery target as a plain travel-and-dock, deliberately without refuel/repair — see module doc. */
export async function runCombatRecovery(
	ctx: LibGoalContext,
	target: RecoveryTarget,
): Promise<GoalResult> {
	return new LibPrepareAtStation({ ...target, refuel: false, repair: false }).execute(ctx);
}
