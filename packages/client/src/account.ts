/** Account-scoped goal API for `@setpoint/client`. */

import type { GoalOptionsMap, GoalResult, GoalType } from "@setpoint/protocol";
import type { SetpointClient } from "./client.js";
import { type WaitForJobOptions, waitForJob } from "./jobs.js";

export interface AbortOptions {
	/** Fire abort signals and clean up in-memory state immediately, instead of just reporting status. */
	force?: boolean;
}

/** Goal API scoped to a single account, identified by player_id or username. */
export class AccountApi {
	constructor(
		private readonly client: SetpointClient,
		private readonly id: string,
	) {}

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
