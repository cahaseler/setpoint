/** Account-scoped goal and loop API for `@setpoint/client`. */

import type {
	GoalOptionsMap,
	GoalResult,
	GoalType,
	LoopOptionsMap,
	LoopStatus,
	LoopType,
} from "@setpoint/protocol";
import type { SetpointClient } from "./client.js";
import { type WaitForJobOptions, waitForJob } from "./jobs.js";

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

/** Goal API scoped to a single account, identified by player_id or username. */
export class AccountApi {
	/** Loop sub-API for this account (`sp.account(id).loop`). */
	readonly loop: AccountLoopApi;

	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {
		this.loop = new AccountLoopApi(client, id);
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
		return waitForJob(this.client, job_id, opts);
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
