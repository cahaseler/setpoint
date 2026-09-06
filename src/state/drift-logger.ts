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
 * Drift paths that silently break goals rather than merely being stale.
 *
 * `location.poi_id` is the one that matters: a movement goal asks "am I already
 * there?" against the cache, and a stale answer makes it skip the travel
 * entirely. Measured on a live fleet, poi_id drifted 284 times across 125
 * accounts in 40 minutes and NEVER without in_transit alongside it — the signature
 * of a transit transition that no push delivered. These are logged at warn with
 * a distinct tag so they can be counted without wading through ambient drift
 * like nearby_players.
 */
const CONSEQUENTIAL_PATHS: ReadonlySet<string> = new Set([
	"location.poi_id",
	"location.system_id",
	"location.docked_at",
	"location.in_transit",
]);

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
	const consequential = paths.filter((p) => CONSEQUENTIAL_PATHS.has(p));

	if (consequential.length > 0) {
		// Tagged so a future investigation can count position drift directly:
		// grep '[position-drift]' rather than filtering 2700 ambient drift lines.
		log.warn(
			`[${who}] [position-drift] cache was stale on ${consequential.join(", ")} — ${JSON.stringify(
				drifts.filter((d) => CONSEQUENTIAL_PATHS.has(pathKey(d))),
			)}`,
		);
	}

	log.info(`[${who}] drift detected: ${paths.join(", ")} — ${JSON.stringify(drifts)}`);
}
