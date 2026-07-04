/**
 * Diagnostic diff between two `GameState` snapshots. Used to detect server-side
 * state changes that arrived via a live `refresh()` (`get_status`) without ever
 * being carried by a push notification — i.e. gaps in the lib's notification
 * coverage. See `drift-logger.ts` for how findings get recorded.
 */

import { type GameState, STATE_SECTIONS, type StateSection } from "@spacemolt/lib";

export interface FieldDrift {
	section: StateSection;
	/** Dot-separated path within the section (empty string if the section itself is a scalar). */
	path: string;
	before: unknown;
	after: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively diffs two values, appending every leaf path where they differ.
 * Objects are compared key-by-key; arrays and primitives are compared by JSON
 * equality — good enough to flag "something in this array changed" without
 * over-engineering a positional/keyed array diff for a diagnostic tool.
 */
function diffValue(
	before: unknown,
	after: unknown,
	path: string,
	out: Array<{ path: string; before: unknown; after: unknown }>,
): void {
	if (before === after) return;

	if (isPlainObject(before) && isPlainObject(after)) {
		const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
		for (const key of keys) {
			diffValue(before[key], after[key], path ? `${path}.${key}` : key, out);
		}
		return;
	}

	if (JSON.stringify(before) === JSON.stringify(after)) return;
	out.push({ path, before, after });
}

/** Diffs every state section between two `GameState` snapshots, returning each leaf field that changed. */
export function diffGameState(before: GameState, after: GameState): FieldDrift[] {
	const drifts: FieldDrift[] = [];
	for (const section of STATE_SECTIONS) {
		const changes: Array<{ path: string; before: unknown; after: unknown }> = [];
		diffValue(before[section], after[section], "", changes);
		for (const change of changes) {
			drifts.push({ section, ...change });
		}
	}
	return drifts;
}
