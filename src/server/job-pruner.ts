/**
 * Keeps the jobs table bounded by deleting finished jobs past a retention
 * window.
 *
 * Nothing pruned job history before this, and every async goal leaves a row:
 * by 2026-10-13 the table held 800k rows (740k of them prepare-at-station)
 * going back six weeks, and was 99% of a 1.2GB database. A caller needs a
 * finished job only long enough to poll its result, and the dashboard shows
 * the last five per account, so a week is generous.
 *
 * Deletes in small batches with a yield between them, because bun:sqlite is
 * synchronous: one statement deleting hundreds of thousands of rows would
 * stall every HTTP request and game push for its whole duration. The first
 * pass after deploying this clears the existing backlog the same way.
 *
 * Deleted rows free pages that SQLite reuses, so the file stops growing but
 * does not shrink. Reclaiming the space already allocated takes a one-off
 * VACUUM with the daemon stopped.
 */

import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import type { JobManager } from "./job-manager.js";

const log = createLogger("job-pruner");

/** Finished jobs older than this are deleted. */
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** About 12ms per batch against a 1.2GB table, measured 2026-10-13. */
const PRUNE_BATCH_SIZE = 1_000;
/** Delay before the first pass, so startup and the fleet connect go first. */
const FIRST_PASS_DELAY_MS = 5 * 60 * 1000;

export interface JobPrunerOptions {
	retentionMs?: number;
	batchSize?: number;
	/** Yield between batches so other work can run. */
	yieldBetweenBatches?: () => Promise<void>;
	now?: () => Date;
}

/**
 * Delete every finished job older than the retention window, in batches.
 * Returns the number deleted. Exported for tests and for the scheduled pass.
 */
export async function pruneFinishedJobs(
	jobManager: JobManager,
	{
		retentionMs = JOB_RETENTION_MS,
		batchSize = PRUNE_BATCH_SIZE,
		yieldBetweenBatches = () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
		now = () => new Date(),
	}: JobPrunerOptions = {},
): Promise<number> {
	const cutoff = new Date(now().getTime() - retentionMs);
	let total = 0;
	for (;;) {
		const deleted = jobManager.pruneFinishedBefore(cutoff, batchSize);
		total += deleted;
		if (deleted < batchSize) return total;
		await yieldBetweenBatches();
	}
}

/** Prune once after a short delay, then hourly. Returns a stop function. */
export function startJobPruner(jobManager: JobManager): { stop: () => void } {
	let running = false;
	const runOnce = async (): Promise<void> => {
		if (running) return;
		running = true;
		try {
			const deleted = await pruneFinishedJobs(jobManager);
			if (deleted > 0) log.info(`Pruned ${deleted} finished job(s) older than 7 days`);
		} catch (err) {
			log.warn(`Job prune failed: ${errorMessage(err)}`);
		} finally {
			running = false;
		}
	};
	const first = setTimeout(() => void runOnce(), FIRST_PASS_DELAY_MS);
	const interval = setInterval(() => void runOnce(), PRUNE_INTERVAL_MS);
	return {
		stop: () => {
			clearTimeout(first);
			clearInterval(interval);
		},
	};
}
