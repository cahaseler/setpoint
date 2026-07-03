import type { StoredGameState } from "../state/store.js";

/** The outcome of executing a goal. */
export interface GoalResult {
	/** Whether the desired state was achieved. */
	success: boolean;
	/** Human-readable description of what happened. */
	message: string;
	/** Whether the goal was already satisfied before execution. */
	alreadySatisfied: boolean;
	/** Number of mutation actions consumed (each costs a tick). */
	ticksUsed: number;
}

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

/** Result of a single step within a compound goal. */
export interface StepResult {
	goalName: string;
	result: GoalResult;
}

/** Extended result for compound goals that execute multiple steps. */
export interface CompoundGoalResult extends GoalResult {
	/** Results from each step that was attempted. */
	steps: StepResult[];
}

/** Result of a single loop iteration. */
export interface IterationResult {
	iteration: number;
	result: GoalResult;
}

/** Extended result for goal loops that run multiple iterations. */
export interface LoopResult extends GoalResult {
	/** Results from each iteration that ran. */
	iterations: IterationResult[];
	/** Total number of iterations completed. */
	iterationCount: number;
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
	 * Defaults to 30000 (30 seconds). RateLimitErrors override this with the
	 * server's retry-after value.
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
