/** Account-scoped goal/loop/state API, plus the top-level accounts collection API, for `@setpoint/client`. */

import type {
	Empire,
	GoalOptionsMap,
	GoalResult,
	GoalType,
	JobRecord,
	LoopOptionsMap,
	LoopStatus,
	LoopType,
	V2GameState,
} from "@setpoint/protocol";
import type { GetSystemResponse } from "@spacemolt/lib";
import type { SetpointClient } from "./client.js";
import { GoalFailedError } from "./errors.js";
import { type WaitForJobOptions, waitForJob } from "./jobs.js";
import { type RawApi, createRawApi } from "./raw.js";

/**
 * True for the daemon's sync-goal failure body — `{error: string}` with no
 * `success` field. `handleExecuteGoal` streams this shape at HTTP 200 when
 * the goal throws (see `GoalFailedError`'s doc comment), so `goal()` must
 * check the body shape rather than trusting `response.ok`.
 */
function isGoalFailureBody(body: unknown): body is { error: string } {
	return (
		typeof body === "object" &&
		body !== null &&
		typeof (body as Record<string, unknown>)["error"] === "string" &&
		!("success" in (body as Record<string, unknown>))
	);
}

export interface AbortOptions {
	/** Fire abort signals and clean up in-memory state immediately, instead of just reporting status. */
	force?: boolean;
}

/**
 * Loop API scoped to a single account. Mirrors the daemon's
 * `POST|GET|PATCH|DELETE /accounts/:id/loop` routes (`src/server/handlers.ts`).
 */
export class AccountLoopApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/** Starts a loop, persisting its config on the daemon. Body is `{type, options}` (matches `handleStartLoop`). */
	async start<T extends LoopType>(type: T, options: LoopOptionsMap[T]): Promise<LoopStatus> {
		const result = await this.client.request(
			"POST",
			`/accounts/${encodeURIComponent(this.id)}/loop`,
			{ body: { type, options } },
		);
		return result as LoopStatus;
	}

	/** Gets the current loop status, or `{running: false}` if no loop has ever run on this account. */
	async get(): Promise<LoopStatus | { running: false }> {
		const result = await this.client.request(
			"GET",
			`/accounts/${encodeURIComponent(this.id)}/loop`,
		);
		return result as LoopStatus | { running: false };
	}

	/**
	 * Patches a running loop's options in place, without restarting it. The
	 * body is the FLAT partial itself — unlike `start`, it is NOT wrapped in
	 * an `options` object (matches `handlePatchLoop`).
	 */
	async patch<T extends LoopType>(partial: Partial<LoopOptionsMap[T]>): Promise<LoopStatus> {
		const result = await this.client.request(
			"PATCH",
			`/accounts/${encodeURIComponent(this.id)}/loop`,
			{ body: partial },
		);
		return result as LoopStatus;
	}

	/** Stops the running loop and deletes its persisted config. */
	async stop(): Promise<{ message: string }> {
		const result = await this.client.request(
			"DELETE",
			`/accounts/${encodeURIComponent(this.id)}/loop`,
		);
		return result as { message: string };
	}
}

/**
 * Game-state API scoped to a single account. Mirrors the daemon's
 * `GET /accounts/:id/state[/:section]` and `POST /accounts/:id/state/refresh`
 * routes (`src/server/handlers.ts`).
 */
export class AccountStateApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/** Gets the full local game state (as fresh as the last mutation response). */
	async get(): Promise<V2GameState> {
		const result = await this.client.request(
			"GET",
			`/accounts/${encodeURIComponent(this.id)}/state`,
		);
		return result as V2GameState;
	}

	/** Gets a single state section (e.g. `"ship"`, `"cargo"`, `"location"`). */
	async section(name: string): Promise<unknown> {
		return this.client.request(
			"GET",
			`/accounts/${encodeURIComponent(this.id)}/state/${encodeURIComponent(name)}`,
		);
	}

	/** Forces a live `get_state` call against the game server and returns the refreshed state. */
	async refresh(): Promise<V2GameState> {
		const result = await this.client.request(
			"POST",
			`/accounts/${encodeURIComponent(this.id)}/state/refresh`,
		);
		return result as V2GameState;
	}
}

/**
 * System/POI-map API scoped to a single account. Mirrors the daemon's
 * `GET /accounts/:id/system[/:systemId]` route (`handleGetSystem` in
 * `src/server/handlers.ts`).
 */
export class AccountSystemApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

	/**
	 * Gets system/POI map data. With no `systemId`, returns the account's
	 * current system (`get_system` always reports the player's own system).
	 * With a `systemId`, the daemon returns that system directly if the
	 * account is there, another connected account's live view if one is in
	 * that system, or a reshaped faction-intel snapshot as a fallback —
	 * `handleGetSystem` normalizes all three to (approximately) this shape.
	 */
	async get(systemId?: string): Promise<GetSystemResponse> {
		const path =
			systemId === undefined
				? `/accounts/${encodeURIComponent(this.id)}/system`
				: `/accounts/${encodeURIComponent(this.id)}/system/${encodeURIComponent(systemId)}`;
		const result = await this.client.request("GET", path);
		return result as GetSystemResponse;
	}
}

/** Goal API scoped to a single account, identified by player_id or username. */
export class AccountApi {
	/** Loop sub-API for this account (`sp.account(id).loop`). */
	readonly loop: AccountLoopApi;

	/** Game-state sub-API for this account (`sp.account(id).state`). */
	readonly state: AccountStateApi;

	/** System/POI-map sub-API for this account (`sp.account(id).system`). */
	readonly system: AccountSystemApi;

	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {
		this.loop = new AccountLoopApi(client, id);
		this.state = new AccountStateApi(client, id);
		this.system = new AccountSystemApi(client, id);
	}

	/**
	 * Typed raw-passthrough API for this account (`sp.account(id).raw`).
	 * `raw.<group>.<action>(params)` POSTs `/accounts/:id/raw` and returns the
	 * daemon's `RawEnvelope`, typed via `@spacemolt/lib`'s `Commands`.
	 */
	get raw(): RawApi {
		return createRawApi(this.client, this.id);
	}

	/**
	 * Executes a goal synchronously, blocking until the daemon returns a result.
	 *
	 * Sync goals can legitimately run for minutes, so the request timeout is
	 * disabled (`timeoutMs: 0`) rather than inherited from the client default.
	 */
	async goal<T extends GoalType>(type: T, options: GoalOptionsMap[T]): Promise<GoalResult> {
		const result = await this.client.request(
			"POST",
			`/accounts/${encodeURIComponent(this.id)}/goal`,
			{
				body: { type, options },
				timeoutMs: 0,
			},
		);
		if (isGoalFailureBody(result)) {
			throw new GoalFailedError(result.error);
		}
		return result as GoalResult;
	}

	/** Submits a goal for background execution, returning a job id immediately (HTTP 202). */
	async goalAsync<T extends GoalType>(
		type: T,
		options: GoalOptionsMap[T],
	): Promise<{ job_id: string }> {
		const result = await this.client.request(
			"POST",
			`/accounts/${encodeURIComponent(this.id)}/goal/async`,
			{
				body: { type, options },
			},
		);
		return result as { job_id: string };
	}

	/**
	 * Submits a goal asynchronously and polls until it reaches a terminal
	 * status, returning the result on success and throwing on failure.
	 */
	async runToCompletion<T extends GoalType>(
		type: T,
		options: GoalOptionsMap[T],
		opts?: WaitForJobOptions,
	): Promise<GoalResult> {
		const { job_id } = await this.goalAsync(type, options);
		const job = await waitForJob(this.client, job_id, opts);
		if (job.status === "failed") {
			throw new Error(job.error ?? `Job ${job_id} failed`);
		}
		return job.result as GoalResult;
	}

	/** Releases the account from all in-progress work (loop, sync goal, or async job). */
	async abort(opts?: AbortOptions): Promise<{ message: string }> {
		const result = await this.client.request(
			"DELETE",
			`/accounts/${encodeURIComponent(this.id)}/abort`,
			{
				body: opts?.force !== undefined ? { force: opts.force } : undefined,
			},
		);
		return result as { message: string };
	}
}

// ── Top-level accounts collection (`sp.accounts`) ────────────────────

/** Slimmed ship summary, as embedded in account list/detail responses. */
export interface AccountShipSummary {
	hull: number;
	max_hull: number;
	fuel: number;
	max_fuel: number;
	cargo_used?: number;
	cargo_capacity?: number;
}

/** Slimmed location summary, as embedded in account list/detail responses. */
export interface AccountLocationSummary {
	system: string | undefined;
	poi: string | undefined;
	docked: string | null;
}

/** One entry in `GET /accounts` (`handleListAccounts`) for a connected account. */
export interface ConnectedAccountSummary {
	player_id: string;
	username: string;
	status: "connected";
	credits: number | null;
	ship: AccountShipSummary | null;
	location: AccountLocationSummary | null;
	loop: LoopStatus | null;
}

/** One entry in `GET /accounts` (`handleListAccounts`) for an account still queued for connection. */
export interface PendingAccountSummary {
	player_id: string | null;
	username: string;
	empire: string;
	status: string;
	credits: null;
	ship: null;
	location: null;
	loop: null;
}

export type AccountSummary = ConnectedAccountSummary | PendingAccountSummary;

/** Response of `GET /accounts` (`handleListAccounts`). */
export interface AccountsListResult {
	accounts: AccountSummary[];
}

/** Slimmed state snapshot embedded in `GET /accounts/:id` (`handleGetAccount`). */
export interface AccountDetailState {
	credits: number | undefined;
	ship: { hull: number; max_hull: number; fuel: number; max_fuel: number } | null;
	location: AccountLocationSummary | null;
}

/**
 * `GET /accounts/:id` (`handleGetAccount`) response. The daemon only resolves
 * connected accounts (`resolveAccount` looks up `ctx.manager`, which holds
 * connected accounts only) — an unresolved id/username 404s instead of
 * returning a "pending" shape, so there is no separate pending-detail variant.
 */
export interface ConnectedAccountDetail {
	player_id: string;
	username: string;
	status: "connected";
	state: AccountDetailState | null;
	loop: LoopStatus | null;
	hasRunningJob: boolean;
	runningJob: unknown;
	hasExecutingGoal: boolean;
	executingGoal: unknown;
	recentJobs: JobRecord[];
}

/** Response of `POST /accounts` (`handleAddAccount`). */
export interface AddAccountResult {
	username: string;
	status: string;
	message: string;
}

export interface RegisterAccountOptions {
	username: string;
	empire: Empire;
}

/** Response of `POST /accounts/register` (`handleRegisterAccount`). */
export interface RegisterAccountResult {
	player_id: string;
	username: string;
	password: string;
	empire: string;
	status: string;
	message: string;
}

/** Response of `DELETE /accounts/:id` (`handleDeleteAccount`). */
export interface RemoveAccountResult {
	message: string;
	player_id?: string;
	username?: string;
}

/**
 * Top-level accounts collection API (`sp.accounts`). Mirrors the daemon's
 * `GET|POST /accounts`, `GET|DELETE /accounts/:id`, and
 * `POST /accounts/register` routes (`src/server/handlers.ts`).
 */
export class AccountsApi {
	constructor(private readonly client: SetpointClient) {}

	/** Lists all connected and pending accounts. */
	async list(): Promise<AccountsListResult> {
		const result = await this.client.request("GET", "/accounts");
		return result as AccountsListResult;
	}

	/** Gets details for a single account, by player_id or username. Throws `SetpointHttpError` (404) if not found. */
	async get(id: string): Promise<ConnectedAccountDetail> {
		const result = await this.client.request("GET", `/accounts/${encodeURIComponent(id)}`);
		return result as ConnectedAccountDetail;
	}

	/** Queues an account for background connection (HTTP 202). */
	async add(username: string): Promise<AddAccountResult> {
		const result = await this.client.request("POST", "/accounts", { body: { username } });
		return result as AddAccountResult;
	}

	/** Registers a brand-new account with the game server and connects it. */
	async register(options: RegisterAccountOptions): Promise<RegisterAccountResult> {
		const result = await this.client.request("POST", "/accounts/register", {
			body: { username: options.username, empire: options.empire },
		});
		return result as RegisterAccountResult;
	}

	/** Disconnects and removes an account, by player_id or username. */
	async remove(id: string): Promise<RemoveAccountResult> {
		const result = await this.client.request("DELETE", `/accounts/${encodeURIComponent(id)}`);
		return result as RemoveAccountResult;
	}
}
