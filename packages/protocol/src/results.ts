import type { CloakedContact, CraftingUpdateEvent, MarketItem, ObservedPlayer } from "./game.js";

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
	/** When `lastStep` was recorded — a `running: true` loop with a stale `lastStepAt` is stalled, not dead. */
	lastStepAt?: string;
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
 *
 * `T` is `structuredContent`'s shape — a query's own response type (e.g.
 * `GetVersionResponse`), or a mutation's delta type (e.g. `MutationResult<
 * JumpResponse>['delta']`, so `structuredContent.details` is the action's own
 * shape, not a generic blob). `@setpoint/client`'s raw passthrough
 * (`packages/client/src/raw.ts`) infers this per action from
 * `@spacemolt/lib`'s `Commands`, so `structuredContent` is never `unknown`
 * for a real command call — only truly generic/untyped callers default to it.
 */
export interface RawEnvelope<T = unknown> {
	result: unknown;
	structuredContent?: T;
	tick?: number;
	command?: string;
}

/**
 * JSON-safe snapshot of a subscribed station's order book (the lib's
 * `account.market(baseId)`), as returned by `GET /accounts/:playerId/market/:baseId`.
 * The lib's `MarketBook.items` is a `Map<item_id, MarketItem>` (not
 * JSON-serializable); `items` here is the same data flattened to an array,
 * matching the shape the game server itself sends in `subscribe_market` and
 * `market_update`. Subscribing is not exposed as a dedicated endpoint — issue
 * `spacemolt_market.subscribe_market` via the raw passthrough first.
 */
export interface MarketBookSnapshot {
	base_id: string;
	base_name?: string;
	/** Tick of the most recent update (0 if only the initial baseline has been seen). */
	tick: number;
	items: MarketItem[];
}

/**
 * JSON-safe snapshot of the observation watch (the lib's `account.observation()`),
 * as returned by `GET /accounts/:playerId/observation`. The lib's
 * `ObservationView` keys `nearby`/`system`/`cloaked` as `Map`s (not
 * JSON-serializable); here they are flattened to arrays, matching the shape
 * the game server sends in `subscribe_observation` and `observation_update`.
 * Subscribing is not exposed as a dedicated endpoint — issue
 * `spacemolt.subscribe_observation` via the raw passthrough first.
 */
export interface ObservationSnapshot {
	poi_id?: string;
	system_id?: string;
	/** Tick of the most recent update (0 if only the initial baseline has been seen). */
	tick: number;
	nearby: ObservedPlayer[];
	system: ObservedPlayer[];
	cloaked: CloakedContact[];
	unknownSignature: boolean;
	activeScan: boolean;
}

/**
 * A single `crafting_update` push, timestamped on receipt and delivered over
 * `GET /accounts/:playerId/crafting/events` (SSE) — both as backlog on
 * connect and live as new pushes arrive. Unlike market/observation, crafting
 * progress requires no explicit subscribe call; the server sends
 * `crafting_update` automatically whenever the account has jobs in progress.
 */
export interface CraftingUpdateEnvelope {
	/** Wall-clock time setpoint received this push (ISO 8601) — the server payload only carries a game tick. */
	receivedAt: string;
	event: CraftingUpdateEvent;
}
