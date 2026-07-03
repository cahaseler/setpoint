import type { GameState, StateSection, V2GameState } from "@spacemolt/lib";
import { createLogger } from "../util/logger.js";
import type { StateStore } from "./store.js";

const log = createLogger("state-projector");

/**
 * Projects the lib's push-fed state cache into the read-only SQLite store.
 * On each state change, writes only the changed sections. The lib's `GameState`
 * and `V2GameState` are distinct nominal types over the same shape; this class
 * is the single place that bridges them.
 */
export class StateProjector {
	constructor(private readonly store: StateStore) {}

	project(playerId: string, state: Readonly<GameState>, changed: StateSection[]): void {
		if (changed.length === 0) {
			return;
		}
		const src = state as Readonly<Record<string, unknown>>;
		const partial: Record<string, unknown> = {};
		for (const section of changed) {
			if (src[section] !== undefined) {
				partial[section] = src[section];
			}
		}
		const written = this.store.applyUpdate(playerId, partial as V2GameState);
		log.debug(`Projected ${written.join(", ") || "nothing"} for ${playerId}`);
	}
}
