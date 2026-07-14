/**
 * Generic in-memory per-key ring buffer + pub/sub, shared by every
 * SSE-backed event store (crafting, combat, ...). Each key (typically a
 * playerId) gets its own bounded backlog and independent listener set —
 * events for one key never leak to a subscriber on another.
 *
 * Not persisted — lost on daemon restart, same as the market/observation
 * caches.
 */

import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("event-buffer");

const DEFAULT_MAX_BUFFERED = 50;

interface Bucket<T> {
	items: T[];
	listeners: Set<(item: T) => void>;
}

export interface EventBuffer<T> {
	/**
	 * Records an item and notifies any live subscribers for this key. The
	 * item is buffered before any listener runs, so it survives even if
	 * every listener throws. Each listener call is isolated from the
	 * others — a listener that throws (e.g. an SSE stream already closed by
	 * a disconnected client) must not stop delivery to a different
	 * subscriber for the same key, and must not propagate back into the
	 * caller's own call stack.
	 */
	record(key: string, item: T): void;
	/** The most recently buffered items for a key, oldest first — backfill for a new subscriber. */
	recent(key: string): T[];
	/** Subscribe to live items for a key as they arrive. Returns an unsubscribe function. */
	subscribe(key: string, listener: (item: T) => void): () => void;
}

export function createEventBuffer<T>(maxBuffered: number = DEFAULT_MAX_BUFFERED): EventBuffer<T> {
	const byKey = new Map<string, Bucket<T>>();

	const bucketFor = (key: string): Bucket<T> => {
		let bucket = byKey.get(key);
		if (!bucket) {
			bucket = { items: [], listeners: new Set() };
			byKey.set(key, bucket);
		}
		return bucket;
	};

	return {
		record(key, item) {
			const bucket = bucketFor(key);
			bucket.items.push(item);
			if (bucket.items.length > maxBuffered) {
				bucket.items.splice(0, bucket.items.length - maxBuffered);
			}
			for (const listener of bucket.listeners) {
				try {
					listener(item);
				} catch (err) {
					log.warn(`[${key}] event buffer listener threw: ${errorMessage(err)}`);
				}
			}
		},
		recent(key) {
			return byKey.get(key)?.items ?? [];
		},
		subscribe(key, listener) {
			const bucket = bucketFor(key);
			bucket.listeners.add(listener);
			return () => bucket.listeners.delete(listener);
		},
	};
}
