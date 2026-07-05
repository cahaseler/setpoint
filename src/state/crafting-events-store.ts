/**
 * In-memory per-account buffer of `crafting_update` pushes, backing
 * `GET /accounts/:playerId/crafting/events` (SSE). Unlike market/observation,
 * `crafting_update` requires no explicit subscribe call — the server sends it
 * automatically whenever the account has jobs in progress — so this store
 * only needs to record what `LibAccountManager` already wires via
 * `account.on('crafting_update', ...)` (see `onCraftingUpdate` in
 * `lib-manager.ts`), with no subscription side to manage.
 *
 * Retention is a small ring buffer per account, not persisted — lost on
 * daemon restart, same as the market/observation caches.
 */

import type { CraftingUpdateEnvelope, CraftingUpdateEvent } from "@setpoint/protocol";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("crafting-events-store");

const MAX_BUFFERED_EVENTS = 50;

interface AccountBuffer {
	events: CraftingUpdateEnvelope[];
	listeners: Set<(envelope: CraftingUpdateEnvelope) => void>;
}

export class CraftingEventsStore {
	private readonly byPlayerId = new Map<string, AccountBuffer>();

	private bufferFor(playerId: string): AccountBuffer {
		let buffer = this.byPlayerId.get(playerId);
		if (!buffer) {
			buffer = { events: [], listeners: new Set() };
			this.byPlayerId.set(playerId, buffer);
		}
		return buffer;
	}

	/**
	 * Records a `crafting_update` push and notifies any live subscribers for
	 * this account. The envelope is buffered before any listener runs, so it
	 * survives even if every listener throws. Each listener call is isolated
	 * from the others — an SSE consumer whose `controller.enqueue()` throws
	 * (e.g. a stream already closed by a disconnected client) must not stop
	 * this push reaching a different subscriber for the same account, and
	 * must not propagate back into the lib's frame-routing call stack that
	 * invoked us (`account.on('crafting_update', ...)` in `lib-manager.ts`).
	 */
	record(playerId: string, event: CraftingUpdateEvent): void {
		const buffer = this.bufferFor(playerId);
		const envelope: CraftingUpdateEnvelope = { receivedAt: new Date().toISOString(), event };
		buffer.events.push(envelope);
		// Debug-level receipt trace, deliberately cheap (job_id/runs_done only) —
		// lets a consumer-reported "N frames expected, M received" gap be
		// localized to before or after this point: if the daemon logged every
		// expected tick here, the loss is in SSE delivery below, not in the
		// game-to-daemon push itself.
		log.debug(
			`[${playerId}] tick=${event.tick} ${event.jobs.map((j) => `${j.job_id}:runs_done=${j.runs_done}`).join(", ")}`,
		);
		if (buffer.events.length > MAX_BUFFERED_EVENTS) {
			buffer.events.splice(0, buffer.events.length - MAX_BUFFERED_EVENTS);
		}
		for (const listener of buffer.listeners) {
			try {
				listener(envelope);
			} catch (err) {
				log.warn(`[${playerId}] crafting event listener threw: ${errorMessage(err)}`);
			}
		}
	}

	/** The most recently buffered events for an account, oldest first — backfill for a new SSE subscriber. */
	recent(playerId: string): CraftingUpdateEnvelope[] {
		return this.byPlayerId.get(playerId)?.events ?? [];
	}

	/** Subscribe to live events for an account as they arrive. Returns an unsubscribe function. */
	subscribe(playerId: string, listener: (envelope: CraftingUpdateEnvelope) => void): () => void {
		const buffer = this.bufferFor(playerId);
		buffer.listeners.add(listener);
		return () => buffer.listeners.delete(listener);
	}
}
