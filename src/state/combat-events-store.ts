/**
 * In-memory per-account buffer of self-relevant combat pushes and synthetic
 * combat-interrupt/recovery events, backing `GET /accounts/:playerId/combat/events`
 * (SSE). Only events the combat detector has confirmed involve the account
 * are recorded here — bystander notifications for nearby fights are filtered
 * out before this store ever sees them (see `src/combat/combat-reactor.ts`).
 *
 * A thin wrapper over the generic `EventBuffer` (`event-buffer.ts`), which
 * owns the actual ring-buffer/pub-sub mechanics shared with
 * `CraftingEventsStore`.
 */

import type { CombatEnvelope } from "@setpoint/protocol";
import { createEventBuffer } from "./event-buffer.js";

export class CombatEventsStore {
	private readonly buffer = createEventBuffer<CombatEnvelope>();

	/** Records a combat envelope and notifies any live subscribers for this account. */
	record(playerId: string, envelope: CombatEnvelope): void {
		this.buffer.record(playerId, envelope);
	}

	/** The most recently buffered events for an account, oldest first — backfill for a new SSE subscriber. */
	recent(playerId: string): CombatEnvelope[] {
		return this.buffer.recent(playerId);
	}

	/** Subscribe to live events for an account as they arrive. Returns an unsubscribe function. */
	subscribe(playerId: string, listener: (envelope: CombatEnvelope) => void): () => void {
		return this.buffer.subscribe(playerId, listener);
	}
}
