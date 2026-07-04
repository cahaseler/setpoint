/**
 * Periodically forces a live `refresh()` across every connected account,
 * purely to surface server-side state drift that no push notification
 * caught — diagnostic data for deciding which `@spacemolt/lib` notification
 * types need wiring (or which the game server still needs to add). Drift
 * detection itself happens in the `refresh()` wrap installed by
 * `LibAccountManager` (see `lib-manager.ts`'s `onDrift` option) — this sweep
 * only supplies refresh calls that would not otherwise happen, so idle
 * accounts (no goals/loops running) still get checked.
 */

import type { LibAccountManager } from "../accounts/lib-manager.js";
import { createLogger } from "../util/logger.js";

const log = createLogger("drift-sweep");

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

export interface DriftSweepOptions {
	/** Delay between sweeps, in milliseconds. Defaults to 10 minutes. */
	intervalMs?: number;
}

export interface DriftSweep {
	stop(): void;
	/**
	 * Runs one sweep pass immediately, bypassing the interval timer. Used both
	 * by tests and by the caller to kick off a pass right after the fleet
	 * finishes connecting, rather than waiting up to a full `intervalMs` for
	 * the first scheduled pass.
	 */
	runOnce(): Promise<void>;
}

/**
 * Starts the sweep. Refreshes are sequential (not concurrent) within a pass —
 * a fleet-wide burst of simultaneous WS traffic is worth avoiding even though
 * queries themselves aren't rate-limited. If a pass is still running when the
 * next tick fires (e.g. a slow network), that tick is skipped rather than
 * running two passes concurrently.
 */
export function startDriftSweep(
	manager: LibAccountManager,
	opts: DriftSweepOptions = {},
): DriftSweep {
	const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
	let stopped = false;
	let sweepInProgress = false;

	async function runSweep(): Promise<void> {
		if (sweepInProgress) {
			log.debug("Skipping sweep tick — previous sweep still running");
			return;
		}
		sweepInProgress = true;
		try {
			const accounts = manager.getAll();
			log.info(`Starting drift sweep across ${accounts.length} account(s)`);
			for (const account of accounts) {
				if (stopped) return;
				try {
					await account.refresh();
				} catch (err) {
					log.debug(`Drift sweep refresh failed for an account: ${err}`);
				}
			}
			log.info("Drift sweep complete");
		} finally {
			sweepInProgress = false;
		}
	}

	const timer = setInterval(() => {
		void runSweep();
	}, intervalMs);

	return {
		stop(): void {
			stopped = true;
			clearInterval(timer);
		},
		runOnce: runSweep,
	};
}
