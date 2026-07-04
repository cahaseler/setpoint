/** Records server-side state drift detected by `LibAccountManager`'s `refresh()` wrap (see `lib-manager.ts`). */

import { createLogger } from "../util/logger.js";
import type { FieldDrift } from "./state-diff.js";

const log = createLogger("drift");

/**
 * Known-benign drift paths excluded from logging — fields that legitimately
 * change on their own and aren't interesting for notification-coverage
 * purposes (e.g. a monotonic clock). Extend this as more noise sources turn up.
 */
const IGNORED_PATHS: ReadonlySet<string> = new Set([
	// Ticks with real time regardless of activity — not a notification gap.
	"player.stats.time_played",
]);

export interface DriftEvent {
	playerId: string;
	username: string | undefined;
	drifts: FieldDrift[];
}

function pathKey(d: FieldDrift): string {
	return d.path ? `${d.section}.${d.path}` : d.section;
}

/**
 * Logs one line per drift-detected refresh (silent once known-benign paths
 * are filtered out and nothing remains), with a scannable path summary plus
 * the full before/after JSON for deep analysis. One line per event (not per
 * field) keeps a single refresh's changes together for whoever is reading
 * the log.
 */
export function logDrift(event: DriftEvent): void {
	const drifts = event.drifts.filter((d) => !IGNORED_PATHS.has(pathKey(d)));
	if (drifts.length === 0) return;

	const who = event.username ?? event.playerId;
	const paths = drifts.map(pathKey);
	log.info(`[${who}] drift detected: ${paths.join(", ")} — ${JSON.stringify(drifts)}`);
}
