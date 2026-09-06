import type {
	FleetOperationResult as FleetOperationResultType,
	GoalResult,
	GoalResult as GoalResultType,
	ReconcileResult as ReconcileResultType,
	ReconcileSubject as ReconcileSubjectType,
} from "@setpoint/protocol";
import type { StoredGameState } from "../state/store.js";

/**
 * The goal/loop result shapes are defined once in `@setpoint/protocol` — the
 * daemon and its typed HTTP client must agree on them field-for-field, so they
 * live in the shared package rather than being mirrored here. Re-exported so
 * the ~70 files under `src/dispatcher/` can keep importing them from their own
 * layer.
 */
export type {
	CompoundGoalResult,
	FleetOperationResult,
	GoalResult,
	IterationResult,
	LoopResult,
	ReconcileAction,
	ReconcileResult,
	ReconcileSubject,
	StepResult,
} from "@setpoint/protocol";

/**
 * Mutable progress tracker shared between an executing goal/sequence and
 * external observers (e.g., the abort handler).
 */
export interface ProgressRef {
	goalType: string;
	goalOptions?: Record<string, unknown>;
	currentStep?: string | undefined;
	completedSteps: string[];
	remainingSteps: string[];
}

/** Options controlling a goal loop. */
export interface LoopOptions {
	/** AbortSignal for external cancellation. */
	signal?: AbortSignal;
	/** Maximum iterations before stopping. Defaults to Infinity. */
	maxIterations?: number;
	/**
	 * Called before each iteration with iteration number and current state.
	 * Return false to stop the loop.
	 */
	shouldContinue?: (iteration: number, state: StoredGameState) => boolean;
	/**
	 * Stop permanently after this many consecutive failures (goal failures or
	 * thrown exceptions). Defaults to 5. Set to 1 for "stop on first failure".
	 */
	maxConsecutiveFailures?: number;
	/**
	 * Milliseconds to wait between retry attempts after a failure.
	 * Defaults to 30000 (30 seconds). Always applies: `@spacemolt/lib` retries
	 * `rate_limited` mutations underneath this engine, so a game-level rate
	 * limit never surfaces here as a failure with its own retry-after.
	 */
	retryDelayMs?: number;
	/**
	 * Called after each iteration completes (success or failure).
	 * Useful for tracking current loop activity in external monitors.
	 */
	onIterationComplete?: (iteration: number, result: GoalResult) => void;
	/**
	 * Called when an iteration fails (result.success === false).
	 * Return true to retry without counting the failure toward maxConsecutiveFailures.
	 * Return false (or omit) to count the failure normally.
	 */
	ignoreFailure?: (result: GoalResult) => boolean;
}

/** Helper to build a successful result when already satisfied. */
export function alreadySatisfied(message: string): GoalResult {
	return { success: true, message, alreadySatisfied: true, ticksUsed: 0 };
}

/** Helper to build a successful result after taking action. */
export function succeeded(message: string, ticksUsed: number): GoalResult {
	return { success: true, message, alreadySatisfied: false, ticksUsed };
}

/** Helper to build a failure result. */
export function failed(message: string, ticksUsed: number): GoalResult {
	return { success: false, message, alreadySatisfied: false, ticksUsed };
}

/**
 * Build a `ReconcileResult` from the subjects a goal acted on.
 *
 * The success invariant lives here and nowhere else: a run is successful only
 * if every subject is `ok`, and already-satisfied only if nothing changed. Goals
 * report subjects and let this derive the verdict, so no goal can accidentally
 * declare success while a subject it was asked to fix stayed broken — the
 * failure mode that let a partial ammo reload report a clean loadout.
 */
export function reconciled(
	subjects: ReconcileSubjectType[],
	ticksUsed: number,
	options?: { message?: string; context?: Record<string, unknown> },
): ReconcileResultType {
	const failedCount = subjects.filter((s) => !s.ok).length;
	const changed = subjects.filter((s) => s.action !== "none").length;
	const summary = {
		total: subjects.length,
		changed,
		unchanged: subjects.length - changed,
		failed: failedCount,
	};

	const defaultMessage =
		subjects.length === 0
			? "Nothing to reconcile"
			: failedCount > 0
				? `${failedCount} of ${summary.total} failed (${changed} changed): ${subjects
						.filter((s) => !s.ok)
						.map((s) => `${s.id}${s.message === undefined ? "" : ` (${s.message})`}`)
						.join("; ")}`
				: changed === 0
					? `All ${summary.total} already correct`
					: `${changed} of ${summary.total} updated`;

	return {
		success: failedCount === 0,
		message: options?.message ?? defaultMessage,
		alreadySatisfied: changed === 0 && failedCount === 0,
		ticksUsed,
		subjects,
		summary,
		...(options?.context !== undefined ? { context: options.context } : {}),
	};
}

/**
 * Build a `FleetOperationResult` from per-account results. Mirrors
 * `reconciled`: the verdict is derived from the parts, never asserted
 * independently of them.
 */
export function fleetOperation(
	accounts: Record<string, GoalResultType>,
	ticksUsed: number,
	options?: { message?: string },
): FleetOperationResultType {
	const entries = Object.entries(accounts);
	const failures = entries.filter(([, r]) => !r.success);
	const summary = {
		total: entries.length,
		succeeded: entries.length - failures.length,
		failed: failures.length,
	};

	const defaultMessage =
		failures.length === 0
			? `All ${summary.total} account(s) succeeded`
			: `${failures.length} of ${summary.total} account(s) failed: ${failures
					.map(([id, r]) => `${id} (${r.message})`)
					.join("; ")}`;

	return {
		success: failures.length === 0,
		message: options?.message ?? defaultMessage,
		alreadySatisfied: entries.every(([, r]) => r.alreadySatisfied),
		ticksUsed,
		accounts,
		summary,
	};
}
