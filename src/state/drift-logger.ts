/** Records server-side state drift detected by `LibAccountManager`'s `refresh()` wrap (see `lib-manager.ts`). */

import { createLogger } from "../util/logger.js";
import type { FieldDrift } from "./state-diff.js";

const log = createLogger("drift");

export interface DriftEvent {
	playerId: string;
	username: string | undefined;
	drifts: FieldDrift[];
}

/**
 * Logs one line per drift-detected refresh (silent when `drifts` is empty),
 * with a scannable path summary plus the full before/after JSON for deep
 * analysis. One line per event (not per field) keeps a single refresh's
 * changes together for whoever is reading the log.
 */
export function logDrift(event: DriftEvent): void {
	if (event.drifts.length === 0) return;

	const who = event.username ?? event.playerId;
	const paths = event.drifts.map((d) => (d.path ? `${d.section}.${d.path}` : d.section));
	log.info(`[${who}] drift detected: ${paths.join(", ")} — ${JSON.stringify(event.drifts)}`);
}
