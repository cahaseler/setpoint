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

/** Status of a running (or previously run) loop, as exposed by the daemon's loop manager. */
export interface LoopStatus {
	type: string;
	startedAt: string;
	running: boolean;
	/** Message from the most recently completed iteration, updated while running. */
	lastStep?: string;
	result?: LoopResult;
	/** Original API options (system IDs, etc.) for route visualization. */
	options?: Record<string, unknown>;
}

export type JobStatus = "pending" | "running" | "completed" | "failed";

/** A record of an async goal job, as tracked by the daemon's job manager. */
export interface JobRecord {
	jobId: string;
	accountId: string;
	goalType?: string;
	goalOptions?: unknown;
	submittedAt: string;
	status: JobStatus;
	completedAt?: string;
	result?: GoalResult;
	error?: string;
}

/**
 * The daemon's normalized raw-passthrough envelope, returned by
 * `POST /accounts/:playerId/raw` (`handleRawAction`). NOT the lib's
 * WS-based `MutationResult`/`QueryResult`. The daemon normalizes both:
 * a mutation resolves as `{ result: delta, structuredContent: delta, tick, command }`
 * and a query as `{ result, structuredContent }` — so `tick`/`command` are
 * present only for mutations, and there is no `notifications` field (push
 * events arrive on the event stream, not on command results).
 */
export interface RawEnvelope {
	result: unknown;
	structuredContent?: unknown;
	tick?: number;
	command?: string;
}
