/**
 * In-memory per-account buffer of `crafting_update` pushes, backing
 * `GET /accounts/:playerId/crafting/events` (SSE). Unlike market/observation,
 * `crafting_update` requires no explicit subscribe call — the server sends it
 * automatically whenever the account has jobs in progress — so this store
 * only needs to record what `LibAccountManager` already wires via
 * `account.on('crafting_update', ...)` (see `onCraftingUpdate` in
 * `lib-manager.ts`), with no subscription side to manage.
 *
 * A thin wrapper over the generic `EventBuffer` (`event-buffer.ts`), which
 * owns the actual ring-buffer/pub-sub mechanics shared with
 * `CombatEventsStore`.
 */

import type { CraftingUpdateEnvelope, CraftingUpdateEvent } from "@setpoint/protocol";
import { createLogger } from "../util/logger.js";
import { createEventBuffer } from "./event-buffer.js";

const log = createLogger("crafting-events-store");

export class CraftingEventsStore {
	private readonly buffer = createEventBuffer<CraftingUpdateEnvelope>();

	/**
	 * Records a `crafting_update` push and notifies any live subscribers for
	 * this account.
	 */
	record(playerId: string, event: CraftingUpdateEvent): void {
		const envelope: CraftingUpdateEnvelope = { receivedAt: new Date().toISOString(), event };
		// Debug-level receipt trace, deliberately cheap (job_id/runs_done only) —
		// lets a consumer-reported "N frames expected, M received" gap be
		// localized to before or after this point: if the daemon logged every
		// expected tick here, the loss is in SSE delivery below, not in the
		// game-to-daemon push itself.
		log.debug(
			`[${playerId}] tick=${event.tick} ${event.jobs.map((j) => `${j.job_id}:runs_done=${j.runs_done}`).join(", ")}`,
		);
		this.buffer.record(playerId, envelope);
	}

	/** The most recently buffered events for an account, oldest first — backfill for a new SSE subscriber. */
	recent(playerId: string): CraftingUpdateEnvelope[] {
		return this.buffer.recent(playerId);
	}

	/** Subscribe to live events for an account as they arrive. Returns an unsubscribe function. */
	subscribe(playerId: string, listener: (envelope: CraftingUpdateEnvelope) => void): () => void {
		return this.buffer.subscribe(playerId, listener);
	}
}
