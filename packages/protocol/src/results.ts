import type {
	CloakedContact,
	CraftingUpdateEvent,
	MarketItem,
	NotificationPayloads,
	ObservedPlayer,
	PirateRadioEvent,
} from "./game.js";

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

/**
 * What a reconciling goal did to one subject it was asked to bring into line.
 *
 * `"none"` covers both "already correct" and "deliberately skipped" — the two
 * are distinguished by `ok` plus `message`, not by a separate action.
 */
export type ReconcileAction = "none" | "created" | "updated" | "removed";

/** Fields common to every reconciled subject, whether it succeeded or not. */
interface ReconcileSubjectBase {
	/**
	 * Whatever addresses this subject in the game — a `module_id`, a
	 * `player_id`, an `item_id`, a ship uuid. Stable enough to diff two runs.
	 */
	id: string;
	/** What sort of thing this is, so a generic consumer can render it. */
	kind: string;
	action: ReconcileAction;
	/** What was asked for. Keeps a stored result diagnosable without the original request. */
	desired?: Record<string, unknown>;
	after?: Record<string, unknown>;
}

/** A subject that reached the desired state (or was already there). */
export interface ReconcileSubjectOk extends ReconcileSubjectBase {
	ok: true;
	/** Why nothing was done, when `action` is `"none"` — e.g. "above half, reload would discard 4". */
	message?: string;
	before?: Record<string, unknown>;
}

/**
 * A subject that did NOT reach the desired state.
 *
 * `message` and `before` are both required, deliberately. A caller submitting a
 * reconcile request is usually working from its own model of the fleet, and the
 * likeliest reason a subject fails is that the model is wrong — the ship is
 * mid-transit, or is not where the caller believed it was. Returning a bare
 * reason code invites the caller to treat the failure as intentional and move
 * on; returning the state we actually observed forces the discrepancy into the
 * open and makes the caller reconcile against reality.
 *
 * So `before` carries what the ship/member/hold actually looked like at the
 * moment of failure (position, in-transit flag, docked base, current holder),
 * not merely the field that was wrong.
 */
export interface ReconcileSubjectFailed extends ReconcileSubjectBase {
	ok: false;
	/**
	 * A prefixed, machine-readable reason token (`cargo_full`, `not_at_poi`,
	 * `busy:mining-loop`, `ambiguous_ammo`) so a caller can branch without
	 * parsing prose.
	 */
	message: string;
	/** The state actually observed. Required — see above. */
	before: Record<string, unknown>;
}

/** One thing a reconciling goal acted on: a weapon, a fleet member, an item stack, a hull, a module slot. */
export type ReconcileSubject = ReconcileSubjectOk | ReconcileSubjectFailed;

/**
 * Result of a goal that reconciles many subjects toward a desired state.
 *
 * The invariant that matters: `success` is true only when EVERY subject is
 * `ok`, and `alreadySatisfied` only when every action is `"none"`. A goal that
 * fixed four of five guns cannot report success — which is the structural fix
 * for a partial reload reporting a clean result.
 *
 * Facts about the ship or fleet as a whole rather than any one subject (hold
 * capacity, the fleet's id, the hull left parked behind) go in `context`, not
 * smuggled into an unrelated subject.
 */
export interface ReconcileResult extends GoalResult {
	subjects: ReconcileSubject[];
	summary: { total: number; changed: number; unchanged: number; failed: number };
	context?: Record<string, unknown>;
}

/**
 * Result of an operation spanning several accounts — a fleet goal driven from
 * a leader, or one goal submitted across a batch. Keyed by `player_id`, so a
 * caller diffs it against the set it asked for.
 */
export interface FleetOperationResult extends GoalResult {
	accounts: Record<string, GoalResult | ReconcileResult>;
	summary: { total: number; succeeded: number; failed: number };
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
	/**
	 * Consecutive failed iterations as of the last one that finished. Zero once
	 * an iteration succeeds. Lets a consumer tell a loop that is failing from
	 * one that simply has not completed its first cycle yet — both report
	 * `running: true`, and before this the only difference was the absence of
	 * `lastStep`, which is also how a healthy first cycle looks.
	 */
	consecutiveFailures?: number;
	/** Message from the most recent failed iteration, including one that failed by throwing. */
	lastFailure?: string;
	/** When `lastFailure` was recorded. */
	lastFailureAt?: string;
	result?: LoopResult;
	/** Original API options (system IDs, etc.) for route visualization. */
	options?: Record<string, unknown>;
}

/**
 * Combat-response mode for an account. `"flee"` (the default) is setpoint's
 * built-in auto-flee response; `"external"` skips it entirely, leaving
 * combat decisions to code outside setpoint — the account is still released
 * from any running loop/goal on combat entry either way, so external combat
 * logic never has to fight a setpoint loop for control, only the built-in
 * flee response.
 */
export type CombatMode = "flee" | "external";

/** Current combat-mode setting for an account, as exposed by GET/PATCH /accounts/:playerId/combat-mode. */
export interface CombatModeStatus {
	playerId: string;
	mode: CombatMode;
}

export type JobStatus = "pending" | "running" | "completed" | "failed";

/**
 * The terminal verdict on a job, absent while it is still pending or running.
 *
 * `status` answers "did the job finish", not "did the thing happen": a goal
 * that ran to conclusion and failed its own preconditions is
 * `status: "completed"` with `result.success: false`, which reads as success at
 * a glance and repeatedly has. `outcome` is the field to branch on.
 */
export type JobOutcome = "succeeded" | "failed" | "aborted";

/** A record of an async goal job, as tracked by the daemon's job manager. */
export interface JobRecord {
	jobId: string;
	accountId: string;
	goalType?: string;
	goalOptions?: unknown;
	submittedAt: string;
	status: JobStatus;
	/** Terminal verdict — set once the job reaches a terminal state. */
	outcome?: JobOutcome;
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

/**
 * A single `pirate_radio` push, timestamped on receipt and delivered over
 * `GET /accounts/:playerId/pirate-radio/events` (SSE) — both as backlog on
 * connect and live as new pushes arrive. Like crafting progress, pirate radio
 * needs no explicit subscribe call; the server sends it to an account that is
 * in range to intercept.
 */
export interface PirateRadioEnvelope {
	/** Wall-clock time setpoint received this push (ISO 8601) — the server payload carries no timestamp of its own. */
	receivedAt: string;
	event: PirateRadioEvent;
}

/**
 * A single combat-relevant push, timestamped on receipt and delivered over
 * `GET /accounts/:playerId/combat/events` (SSE) — both as backlog on connect
 * and live as new pushes arrive. Only self-relevant events are recorded (the
 * account is a confirmed participant) — see `src/combat/combat-detector.ts`.
 */
export type CombatRawEnvelope =
	| { receivedAt: string; type: "battle_alert"; payload: NotificationPayloads["battle_alert"] }
	| { receivedAt: string; type: "battle_started"; payload: NotificationPayloads["battle_started"] }
	| { receivedAt: string; type: "battle_joined"; payload: NotificationPayloads["battle_joined"] }
	| { receivedAt: string; type: "battle_update"; payload: NotificationPayloads["battle_update"] }
	| { receivedAt: string; type: "battle_damage"; payload: NotificationPayloads["battle_damage"] }
	| { receivedAt: string; type: "battle_ended"; payload: NotificationPayloads["battle_ended"] }
	| { receivedAt: string; type: "battle_left"; payload: NotificationPayloads["battle_left"] }
	| { receivedAt: string; type: "player_died"; payload: NotificationPayloads["player_died"] }
	| { receivedAt: string; type: "player_kill"; payload: NotificationPayloads["player_kill"] };

/** Recovery target setpoint decided to send the ship to after combat resolved, if any. */
export interface CombatRecoveryTarget {
	systemId: string;
	poiId: string;
	baseId: string;
}

export interface CombatInterruptedPayload {
	battleId: string;
	previousLoopType?: string | undefined;
	previousGoalType?: string | undefined;
}

export interface CombatRecoveryPayload {
	target?: CombatRecoveryTarget;
	message?: string;
}

/** Synthetic events setpoint itself emits around a combat interruption, alongside the raw game pushes. */
export type CombatSyntheticEnvelope =
	| { receivedAt: string; type: "combat_interrupted"; payload: CombatInterruptedPayload }
	| { receivedAt: string; type: "combat_recovery_started"; payload: CombatRecoveryPayload }
	| { receivedAt: string; type: "combat_recovery_completed"; payload: CombatRecoveryPayload }
	| { receivedAt: string; type: "combat_recovery_failed"; payload: CombatRecoveryPayload };

export type CombatEnvelope = CombatRawEnvelope | CombatSyntheticEnvelope;
