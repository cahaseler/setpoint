import type { GoalResult } from "@setpoint/protocol";
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
	GoalResult,
	IterationResult,
	LoopResult,
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
