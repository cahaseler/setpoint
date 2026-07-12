/**
 * Force-releases every in-progress unit of work for an account — loop,
 * synchronous goal, and async job — immediately. Deep blocking waits
 * (action_in_progress retries, transit polls) inside `@spacemolt/lib`'s
 * session layer don't check abort signals, so the old promises may take
 * 30s+ to actually settle in the background; this only signals everything
 * and clears the in-memory "busy" state right away, which is what lets a
 * caller submit new work immediately.
 *
 * Shared by the HTTP force-abort path (`handleAbortAccount` in
 * `handlers.ts`) and `CombatReactor` (`src/combat/combat-reactor.ts`), so
 * both go through identical release logic.
 */

import type { ProgressRef } from "../dispatcher/goals.js";
import { errorMessage } from "../util/errors.js";
import { createLogger } from "../util/logger.js";
import type { JobManager } from "./job-manager.js";
import type { LoopManager } from "./loop-manager.js";

const log = createLogger("account-release");

/** A synchronous goal currently executing for an account. */
export interface ExecutingGoalEntry {
	goalType: string;
	goalOptions?: Record<string, unknown>;
	startedAt: string;
	controller: AbortController;
	progress: ProgressRef;
	promise: Promise<unknown>;
}

export interface AccountReleaseDeps {
	loopManager: LoopManager;
	jobManager: JobManager;
	executingGoals: Map<string, ExecutingGoalEntry>;
	configDir: string;
}

export function forceReleaseAccount(deps: AccountReleaseDeps, playerId: string): void {
	const loopStatus = deps.loopManager.getStatus(playerId);
	const syncGoal = deps.executingGoals.get(playerId);
	const runningJob = deps.jobManager.getRunningJob(playerId);
	const jobExecution = runningJob ? deps.jobManager.getExecutionForAccount(playerId) : undefined;

	log.info(`[${playerId}] Force release initiated`);

	if (loopStatus?.running) {
		deps.loopManager.forceRemove(playerId);
		deps.loopManager.deleteLoopConfig(playerId, deps.configDir).catch((err) => {
			log.warn(`Failed to delete loop config: ${errorMessage(err)}`);
		});
	}

	if (syncGoal) {
		syncGoal.controller.abort();
	}

	if (runningJob && jobExecution) {
		jobExecution.controller.abort();
	}

	deps.executingGoals.delete(playerId);
	deps.jobManager.failAllRunning(playerId);

	log.info(`[${playerId}] Force release complete, signals fired and state cleaned up`);
}
